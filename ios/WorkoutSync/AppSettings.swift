import Foundation

/// Where to post and with which key. Backlog item 5.
/// The base URL is not secret (UserDefaults); the key is (Keychain).
@MainActor
final class AppSettings: ObservableObject {
    @Published var baseURL: String
    @Published var apiKey: String
    @Published private(set) var testResult: String?
    @Published private(set) var testing = false

    private static let urlKey = "baseURL"
    private static let apiKeyAccount = "ingestApiKey"

    init() {
        baseURL = UserDefaults.standard.string(forKey: Self.urlKey) ?? ""
        apiKey = Keychain.read(Self.apiKeyAccount) ?? ""
    }

    var isConfigured: Bool { endpoint(path: "api/health") != nil && !apiKey.isEmpty }

    func save() {
        baseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        UserDefaults.standard.set(baseURL, forKey: Self.urlKey)
        Keychain.write(apiKey, for: Self.apiKeyAccount)
    }

    /// `https://host` + `api/…`, tolerating a trailing slash. Only https is accepted.
    func endpoint(path: String) -> URL? {
        var base = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: "\(base)/\(path)"), url.scheme == "https", url.host != nil else { return nil }
        return url
    }

    func request(path: String, method: String = "GET") -> URLRequest? {
        guard let url = endpoint(path: path) else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = method
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        // Labels the push "iPhone app" on the server (the silence alert, the logs).
        request.setValue("workout-sync-ios", forHTTPHeaderField: "x-client")
        return request
    }

    /// Two checks: the server answers at all (unauthenticated `/api/health`), then the key
    /// is accepted (an authenticated read of one workout). Reads only; nothing is written.
    func testConnection() async {
        save()
        testing = true
        defer { testing = false }
        guard let health = endpoint(path: "api/health") else {
            testResult = "Base URL must start with https://"
            return
        }
        do {
            let (_, response) = try await URLSession.shared.data(from: health)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                testResult = "Server answered \((response as? HTTPURLResponse)?.statusCode ?? 0) on /api/health"
                return
            }
            guard let authed = request(path: "api/workouts?limit=1") else { return }
            let (_, keyed) = try await URLSession.shared.data(for: authed)
            switch (keyed as? HTTPURLResponse)?.statusCode ?? 0 {
            case 200: testResult = "OK: server reachable, key accepted"
            case 401: testResult = "Server reachable, but the API key was rejected"
            case let code: testResult = "Server reachable, key check answered \(code)"
            }
        } catch {
            testResult = error.localizedDescription
        }
    }
}
