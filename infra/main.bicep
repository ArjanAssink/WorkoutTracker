// Workout Tracker — Azure infrastructure.
//
// Everything here is chosen to sit inside Azure's always-free allowances:
//   * Functions on the Consumption (Y1) plan — 1M executions and 400,000 GB-s per month free.
//     A workout a day is roughly four orders of magnitude under that.
//   * A single Standard_LRS storage account, which the Function App requires anyway, also
//     holding the workouts table. At this volume the cost is a few cents a month.
//   * Application Insights capped at 0.1 GB/day so a logging loop cannot produce a bill.
//
// Deploy:
//   az deployment group create -g <rg> -f infra/main.bicep -p namePrefix=<prefix> ingestApiKey=<key>

@description('Short prefix for resource names. Lowercase letters and digits only.')
@minLength(3)
@maxLength(12)
param namePrefix string

@description('Region for all resources.')
param location string = resourceGroup().location

@description('Shared secret the Apple Shortcut sends in the x-api-key header.')
@secure()
param ingestApiKey string

@description('Read-only token for the iCalendar feed. Passed in the query string, because calendar clients cannot send headers — so it is deliberately separate from ingestApiKey. Empty disables the feed.')
@secure()
param calendarToken string = ''

@description('Resting heart rate, bpm. Used by the TRIMP effort model.')
param restingHeartRate int = 60

@description('Maximum heart rate, bpm. Used by the TRIMP effort model.')
param maxHeartRate int = 185

@description('Body mass in kg.')
param weightKg int = 80

@description('Banister TRIMP weighting factor: 1.92 for men, 1.67 for women.')
param trimpFactor string = '1.92'

// Storage account names are globally unique, lowercase, and capped at 24 characters.
var uniqueSuffix = uniqueString(resourceGroup().id)
var storageAccountName = toLower('${take(namePrefix, 11)}st${take(uniqueSuffix, 8)}')
var functionAppName = '${namePrefix}-func-${take(uniqueSuffix, 6)}'
var hostingPlanName = '${namePrefix}-plan'
var appInsightsName = '${namePrefix}-insights'
var logAnalyticsName = '${namePrefix}-logs'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    accessTier: 'Hot'
  }
}

resource workoutsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  name: '${storage.name}/default/workouts'
}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    // The free grant is 5 GB/month; this app will not come close, but cap it anyway.
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json('0.1')
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

// Flex Consumption (FC1) — Azure's current Linux serverless plan. It scales to zero,
// bills per execution and GB-second beyond a monthly free grant, and at roughly sixty
// executions a month this app sits orders of magnitude below it.
//
// The legacy Linux Consumption plan (Y1/Dynamic) is deliberately not used: new Linux Y1
// apps no longer come up in this subscription — the site and its SCM endpoint both serve
// 503 "service is unavailable" with no content ever deployable — and Flex is the
// supported replacement.
resource hostingPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: hostingPlanName
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

// Flex Consumption serves the app from a zip in blob storage rather than from a
// file share, so the container has to exist before the site references it.
resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${storage.name}/default/deployment-package'
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    // Flex Consumption configures the runtime and scaling here rather than through
    // linuxFxVersion and FUNCTIONS_* app settings, which it ignores.
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}deployment-package'
          authentication: {
            type: 'StorageAccountConnectionString'
            storageAccountConnectionStringName: 'DEPLOYMENT_STORAGE_CONNECTION_STRING'
          }
        }
      }
      scaleAndConcurrency: {
        // No always-ready instances: those bill continuously, which would defeat the point.
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '24'
      }
    }
    siteConfig: {
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      cors: {
        allowedOrigins: []
      }
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          // Read by functionAppConfig.deployment above to fetch the app's zip.
          name: 'DEPLOYMENT_STORAGE_CONNECTION_STRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        {
          name: 'INGEST_API_KEY'
          value: ingestApiKey
        }
        {
          name: 'CALENDAR_TOKEN'
          value: calendarToken
        }
        {
          name: 'WORKOUTS_TABLE'
          value: 'workouts'
        }
        {
          name: 'WORKOUTS_USER_ID'
          value: 'me'
        }
        {
          name: 'ATHLETE_RESTING_HR'
          value: string(restingHeartRate)
        }
        {
          name: 'ATHLETE_MAX_HR'
          value: string(maxHeartRate)
        }
        {
          name: 'ATHLETE_WEIGHT_KG'
          value: string(weightKg)
        }
        {
          name: 'ATHLETE_TRIMP_FACTOR'
          value: trimpFactor
        }
      ]
    }
  }
  dependsOn: [
    workoutsTable
    deploymentContainer
  ]
}

output functionAppName string = functionApp.name
output functionAppHostname string = functionApp.properties.defaultHostName
output ingestEndpoint string = 'https://${functionApp.properties.defaultHostName}/api/workouts'
output dashboardUrl string = 'https://${functionApp.properties.defaultHostName}/api/dashboard'
output storageAccountName string = storage.name
