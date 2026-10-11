#!/usr/bin/env bash
#
# One-time wiring so GitHub Actions can deploy to the Flex Consumption function app.
#
# Flex Consumption has no publish profile, so CI must authenticate with RBAC. This sets up
# OIDC rather than a stored client secret: GitHub mints a short-lived token for each run and
# Azure trusts it through a federated credential, so there is no long-lived credential in
# the repository to rotate or leak.
#
# Needs: az (logged in), gh (logged in), and permission to create an app registration in
# the tenant. Safe to re-run — every step is idempotent.
#
#   ./scripts/setup-github-oidc.sh
#
set -euo pipefail

# Names come from the gitignored .env (see .env.example).
[ -f "$(dirname "$0")/../.env" ] && { set -a; . "$(dirname "$0")/../.env"; set +a; }
REPO="${REPO:-${GITHUB_REPO:?set GITHUB_REPO (owner/name) in .env}}"
RESOURCE_GROUP="${RESOURCE_GROUP:-${AZURE_RESOURCE_GROUP:?set AZURE_RESOURCE_GROUP in .env}}"
APP_NAME="${APP_NAME:-${AZURE_FUNCTION_APP:?set AZURE_FUNCTION_APP in .env}}"
AAD_APP="${AAD_APP:-workout-tracker-github-deploy}"
# Must match the `environment:` in .github/workflows/deploy.yml.
ENVIRONMENT="${ENVIRONMENT:-production}"

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Subscription : $SUBSCRIPTION_ID"
echo "Tenant       : $TENANT_ID"
echo "Repo         : $REPO"
echo

# 1. App registration ---------------------------------------------------------
CLIENT_ID=$(az ad app list --display-name "$AAD_APP" --query '[0].appId' -o tsv)
if [ -z "$CLIENT_ID" ]; then
  echo "Creating app registration '$AAD_APP'..."
  CLIENT_ID=$(az ad app create --display-name "$AAD_APP" --query appId -o tsv)
else
  echo "Reusing app registration '$AAD_APP'"
fi
echo "Client ID    : $CLIENT_ID"

# 2. Service principal --------------------------------------------------------
if ! az ad sp show --id "$CLIENT_ID" >/dev/null 2>&1; then
  echo "Creating service principal..."
  az ad sp create --id "$CLIENT_ID" -o none
fi

# 3. Federated credential -----------------------------------------------------
# The subject must match exactly what GitHub puts in the token. A job that declares
# `environment: production` gets the environment subject, not the branch one.
SUBJECT="repo:${REPO}:environment:${ENVIRONMENT}"
if ! az ad app federated-credential list --id "$CLIENT_ID" --query "[?subject=='$SUBJECT']" -o tsv | grep -q .; then
  echo "Creating federated credential for $SUBJECT..."
  az ad app federated-credential create --id "$CLIENT_ID" --parameters "{
    \"name\": \"github-${ENVIRONMENT}\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"${SUBJECT}\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }" -o none
else
  echo "Federated credential already present"
fi

# 4. Role assignment ----------------------------------------------------------
# Scoped to the one resource group, not the subscription.
SCOPE="/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RESOURCE_GROUP}"
echo "Granting Contributor on ${RESOURCE_GROUP}..."
az role assignment create --assignee "$CLIENT_ID" --role Contributor --scope "$SCOPE" -o none 2>/dev/null \
  || echo "  (already assigned)"

# 5. GitHub secrets and variable ---------------------------------------------
echo "Setting GitHub secrets..."
gh secret set AZURE_CLIENT_ID       --repo "$REPO" --body "$CLIENT_ID"
gh secret set AZURE_TENANT_ID       --repo "$REPO" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUBSCRIPTION_ID"
gh secret set AZURE_FUNCTIONAPP_NAME --repo "$REPO" --body "$APP_NAME"
gh variable set DEPLOY_ENABLED      --repo "$REPO" --body true

echo
echo "Done. Deploy with:  gh workflow run deploy.yml --repo $REPO"
