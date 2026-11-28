import SwiftUI

/// The dashboard fills the app; the native sync screen is a sheet over it, opened from the
/// dashboard's phone-sync chip. Until a server and key are set, the native screen is all there is.
struct RootView: View {
    @EnvironmentObject private var settings: AppSettings
    @EnvironmentObject private var bridge: WebBridge
    @EnvironmentObject private var recorder: WorkoutRecorder

    var body: some View {
        content
            .fullScreenCover(isPresented: $recorder.screenShown) { RecordView() }
    }

    @ViewBuilder
    private var content: some View {
        if settings.isConfigured {
            DashboardWebView(bridge: bridge)
                .ignoresSafeArea()
                .overlay {
                    if let error = bridge.loadError { LoadFailed(message: error) }
                }
                .overlay(alignment: .bottomTrailing) {
                    if recorder.isBusy {
                        RecordingBar().padding(.bottom, 8)
                    } else {
                        RecordButton().padding(20)
                    }
                }
                .sheet(isPresented: $bridge.syncScreenRequested, onDismiss: bridge.loadIfNeeded) {
                    SyncView(onDone: { bridge.syncScreenRequested = false })
                }
                // Continues the launch screen until the dashboard has drawn, then fades.
                .overlay {
                    if !bridge.firstLoadDone { LaunchCover().transition(.opacity) }
                }
                .animation(.easeOut(duration: 0.25), value: bridge.firstLoadDone)
                .task {
                    try? await Task.sleep(for: .seconds(8))
                    bridge.endLaunchCover()
                }
        } else {
            SyncView()
        }
    }
}

/// The launch screen (Info.plist `UILaunchScreen`) drawn again in SwiftUI, so the hand-over
/// from iOS's static image is seamless: same colour, same logo at its natural size, centred
/// on the full screen as iOS centres it.
private struct LaunchCover: View {
    var body: some View {
        ZStack {
            Color("LaunchBackground")
            Image("LaunchLogo")
        }
        .ignoresSafeArea()
        .accessibilityElement()
        .accessibilityLabel("Loading")
    }
}

private struct LoadFailed: View {
    @EnvironmentObject private var bridge: WebBridge
    let message: String

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.exclamationmark").font(.largeTitle).foregroundStyle(.secondary)
            Text("Could not load the dashboard").font(.headline)
            Text(message).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            HStack {
                Button("Try again") { bridge.reload() }.buttonStyle(.borderedProminent)
                Button("Sync & settings") { bridge.syncScreenRequested = true }.buttonStyle(.bordered)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}
