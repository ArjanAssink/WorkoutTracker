import SwiftUI

/// Backlog item 2: proves signing and install work before any HealthKit code exists.
struct ContentView: View {
    private var build: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let number = info?["CFBundleVersion"] as? String ?? "?"
        return "\(version) (\(number))"
    }

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "figure.run")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Workout Sync")
                .font(.title.bold())
            Text("Running natively. Build \(build)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
