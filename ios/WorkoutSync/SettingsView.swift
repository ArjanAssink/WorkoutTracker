import SwiftUI

struct SettingsView: View {
    @ObservedObject var settings: AppSettings
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://…", text: $settings.baseURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server")
                } footer: {
                    Text("The tracker's address, without /api.")
                }
                Section {
                    SecureField("x-api-key", text: $settings.apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("API key")
                } footer: {
                    Text("Stored in the Keychain on this phone only.")
                }
                Section {
                    Button {
                        Task { await settings.testConnection() }
                    } label: {
                        HStack {
                            Text("Test connection")
                            Spacer()
                            if settings.testing { ProgressView() }
                        }
                    }
                    .disabled(settings.testing)
                    if let result = settings.testResult {
                        Text(result).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        settings.save()
                        dismiss()
                    }
                }
            }
        }
    }
}
