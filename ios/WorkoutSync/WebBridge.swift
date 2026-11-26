import Combine
import SwiftUI
import UIKit
import WebKit

/// The dashboard, in a web view, and the two-way bridge between it and the native app.
///
/// - **Key**: before any page script runs, the API key from the Keychain is written into the
///   page's localStorage under the name the pages read (`workout-tracker.apiKey`), so the
///   key gate never shows. Only on the configured host.
/// - **Status → page**: `window.workoutSyncNative` carries the sync status, and a
///   `workout-sync-native` event fires when it changes; the dashboard's chip renders it.
/// - **Page → app**: the chip posts `{ action: "openSync" }` to the `workoutSync` handler,
///   which opens the native sync screen.
/// Links to other hosts open in Safari.
@MainActor
final class WebBridge: NSObject, ObservableObject {
    @Published var syncScreenRequested = false
    @Published private(set) var loadError: String?

    let webView: WKWebView
    private let settings: AppSettings
    private let sync: SyncEngine
    private var loaded: (url: URL, key: String)?
    private var statusWatch: AnyCancellable?

    private static let keyStorage = "workout-tracker.apiKey"
    private static let handlerName = "workoutSync"

    init(settings: AppSettings, sync: SyncEngine) {
        self.settings = settings
        self.sync = sync
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.configuration.userContentController.add(WeakHandler(self), name: Self.handlerName)
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true   // Safari → Develop → this iPhone, for debugging
        let refresh = UIRefreshControl()
        refresh.addTarget(self, action: #selector(pullToRefresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        // objectWillChange fires before the value changes; read it on the next turn.
        statusWatch = sync.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in self?.pushStatus() }
    }

    /// Loads the dashboard if nothing is loaded yet, or reloads when the server or key changed.
    func loadIfNeeded() {
        guard let url = settings.endpoint(path: "api/dashboard"), !settings.apiKey.isEmpty else { return }
        if let loaded, loaded.url == url, loaded.key == settings.apiKey { return }
        loaded = (url, settings.apiKey)
        installScripts()
        loadError = nil
        webView.load(URLRequest(url: url))
    }

    func reload() {
        loadError = nil
        if webView.url == nil { loaded = nil; loadIfNeeded() } else { webView.reload() }
    }

    @objc private func pullToRefresh(_ control: UIRefreshControl) {
        reload()
        Task { await sync.sync(trigger: "On open") }
    }

    // MARK: scripts

    private var statusObject: [String: Any] {
        var status: [String: Any] = ["syncing": sync.syncing, "failed": sync.lastFailed]
        if let when = sync.lastSuccess { status["lastSuccess"] = ISO8601DateFormatter().string(from: when) }
        if let text = sync.lastResult { status["lastResult"] = text }
        return status
    }

    private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }

    /// Re-installed whenever the key or the status changes, so every later page load gets
    /// the current values before its own scripts run.
    private func installScripts() {
        guard let host = settings.endpoint(path: "api/dashboard")?.host else { return }
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        let source = """
        (function () {
          if (location.host !== \(Self.json(host))) return;
          try {
            var key = \(Self.json(settings.apiKey));
            if (localStorage.getItem(\(Self.json(Self.keyStorage))) !== key) localStorage.setItem(\(Self.json(Self.keyStorage)), key);
          } catch (e) {}
          window.workoutSyncNative = \(Self.json(statusObject));
        })();
        """
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func pushStatus() {
        installScripts()
        let js = "window.workoutSyncNative = \(Self.json(statusObject)); window.dispatchEvent(new Event('workout-sync-native'));"
        webView.evaluateJavaScript(js, completionHandler: nil)
        if !sync.syncing { webView.scrollView.refreshControl?.endRefreshing() }
    }
}

extension WebBridge: WKScriptMessageHandler {
    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let action = (message.body as? [String: Any])?["action"] as? String
        Task { @MainActor in
            if action == "openSync" { self.syncScreenRequested = true }
        }
    }
}

extension WebBridge: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        let ownHost = settings.endpoint(path: "api/dashboard")?.host
        if url.scheme == "about" || url.host == ownHost { return .allow }
        // Anything else (a link out, a mailto:) belongs in its own app, not in this frame.
        if action.navigationType == .linkActivated || action.targetFrame?.isMainFrame == true {
            _ = await UIApplication.shared.open(url)
            return .cancel
        }
        return .allow
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadError = nil
        webView.scrollView.refreshControl?.endRefreshing()
        pushStatus()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    private func fail(_ error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        if (error as NSError).code == NSURLErrorCancelled { return }
        loadError = error.localizedDescription
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Hosts the bridge's single web view, so it survives SwiftUI re-renders.
struct DashboardWebView: UIViewRepresentable {
    let bridge: WebBridge
    func makeUIView(context: Context) -> WKWebView {
        bridge.loadIfNeeded()
        return bridge.webView
    }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
