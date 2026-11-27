import SwiftUI

/// Record a workout from a Bluetooth heart-rate strap: pick the activity, connect the strap,
/// Start; End; then Save to Health (or Resume, or Discard). The phone can be locked and put
/// away in between — readings keep arriving in the background.
struct RecordView: View {
    @EnvironmentObject private var recorder: WorkoutRecorder
    @EnvironmentObject private var monitor: HeartRateMonitor

    var body: some View {
        NavigationStack {
            Group {
                switch recorder.phase {
                case .idle: SetupView()
                case .recording: LiveView()
                case .review, .saving: ReviewView()
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if recorder.phase == .idle {
                        Button("Close") { recorder.close() }
                    } else {
                        // The recording carries on; the bar over the dashboard brings this back.
                        Button { recorder.close() } label: { Image(systemName: "chevron.down") }
                            .accessibilityLabel("Hide")
                    }
                }
            }
        }
    }

    private var title: String {
        switch recorder.phase {
        case .idle: return "Record a workout"
        case .recording: return recorder.recording?.activity.label ?? "Recording"
        case .review, .saving: return "Save workout"
        }
    }
}

// MARK: - Before

private struct SetupView: View {
    @EnvironmentObject private var recorder: WorkoutRecorder
    @EnvironmentObject private var monitor: HeartRateMonitor

    var body: some View {
        List {
            if let message = recorder.message {
                Section { Text(message).foregroundStyle(.secondary) }
            }
            Section("Activity") {
                Picker("Activity", selection: $recorder.activity) {
                    ForEach(RecordedActivity.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.inline)
                .labelsHidden()
            }
            StrapSection()
            if !recorder.canWriteHealth {
                Section {
                    Text("Health has not allowed Workout Sync to save workouts and heart rate. Settings → Health → Data Access & Devices → Workout Sync → turn on Workouts and Heart Rate.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            Section {
                Toggle("Training starts later", isOn: $recorder.startLater)
                if recorder.startLater {
                    DatePicker("Starts at", selection: $recorder.startTime, displayedComponents: .hourAndMinute)
                }
            } footer: {
                if recorder.startLater {
                    Text("The strap connects now; the workout starts at \(recorder.startTime.formatted(date: .omitted, time: .shortened)). Readings before then don't count.")
                }
            }
            Section {
                Button(action: recorder.start) {
                    Label(startLabel, systemImage: "play.fill")
                        .frame(maxWidth: .infinity)
                        .font(.title3.bold())
                }
                .buttonStyle(.borderedProminent)
                .listRowInsets(EdgeInsets())
                .disabled(!connected)
            } footer: {
                Text(connected
                     ? "Lock the phone and put it away. Readings keep coming in, and a dropout reconnects by itself. When you're done, switch the strap off: after \(Int(WorkoutRecorder.strapGoneLimit / 60)) quiet minutes the workout ends at its last reading, and a notification takes you to Save."
                     : "Start is available once the strap is connected.")
            }
        }
    }

    private var connected: Bool {
        if case .connected = monitor.status { return true }
        return false
    }

    private var startLabel: String {
        recorder.startLater ? "Start at \(recorder.startTime.formatted(date: .omitted, time: .shortened))" : "Start"
    }
}

private struct StrapSection: View {
    @EnvironmentObject private var monitor: HeartRateMonitor

    var body: some View {
        Section {
            StrapStatusRow()
            if showList {
                ForEach(monitor.found) { strap in
                    Button { monitor.choose(strap.id) } label: {
                        HStack {
                            Image(systemName: "heart.circle")
                            Text(strap.name)
                            Spacer()
                            if strap.rssi != 0 { Text("\(strap.rssi) dBm").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                if monitor.scanning {
                    HStack {
                        ProgressView()
                        Text("Looking for straps… Wear the strap and switch it on.").foregroundStyle(.secondary)
                    }
                } else {
                    Button("Search for straps") { monitor.scan() }
                }
            }
        } header: {
            Text("Heart-rate strap")
        } footer: {
            if monitor.hasSavedStrap {
                HStack {
                    Button("Use a different strap") { monitor.scan() }
                    Spacer()
                    Button("Forget", role: .destructive) { monitor.forget() }
                }
                .font(.footnote)
            } else {
                Text("Polar OH1: press its button until the light blinks. It can be connected to one other app at the same time, so Polar Flow does not need to be closed — but don't record there too.")
            }
        }
    }

    private var showList: Bool {
        switch monitor.status {
        case .noStrap, .searching: return true
        default: return monitor.scanning
        }
    }
}

private struct StrapStatusRow: View {
    @EnvironmentObject private var monitor: HeartRateMonitor

    var body: some View {
        HStack {
            Image(systemName: icon).foregroundStyle(colour)
            VStack(alignment: .leading) {
                Text(text)
                if let battery = monitor.battery, isConnected {
                    Text("Battery \(battery)%").font(.caption).foregroundStyle(battery < 20 ? Color.orange : Color.secondary)
                }
            }
            Spacer()
            if let bpm = monitor.bpm {
                Text("\(bpm)").font(.title2.monospacedDigit().bold())
                Text("bpm").font(.caption).foregroundStyle(.secondary)
            } else if isConnected, monitor.contact == false {
                Text("no skin contact").font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private var isConnected: Bool {
        if case .connected = monitor.status { return true }
        return false
    }

    private var text: String {
        switch monitor.status {
        case .inactive: return "Not connected"
        case .unavailable(let why): return why
        case .noStrap: return "No strap chosen yet"
        case .searching: return "Searching…"
        case .connecting(let name): return "Waiting for \(name)…"
        case .connected(let name): return name
        }
    }

    private var icon: String {
        switch monitor.status {
        case .connected: return "heart.fill"
        case .unavailable: return "exclamationmark.triangle"
        default: return "heart.slash"
        }
    }

    private var colour: Color {
        switch monitor.status {
        case .connected: return .red
        case .unavailable: return .orange
        default: return .secondary
        }
    }
}

// MARK: - During

private struct LiveView: View {
    @EnvironmentObject private var recorder: WorkoutRecorder
    @EnvironmentObject private var monitor: HeartRateMonitor
    @State private var confirmingEnd = false

    var body: some View {
        VStack(spacing: 28) {
            Spacer()
            TimelineView(.periodic(from: .now, by: 1)) { context in
                if let rec = recorder.recording, rec.waiting(at: context.date) {
                    VStack(spacing: 4) {
                        Text("Starts at \(rec.start.formatted(date: .omitted, time: .shortened))")
                            .font(.headline).foregroundStyle(.secondary)
                        Text("−" + Format.clock(rec.start.timeIntervalSince(context.date)))
                            .font(.system(size: 64, weight: .semibold, design: .rounded).monospacedDigit())
                            .foregroundStyle(.secondary)
                        Button("Start now", action: recorder.startNow)
                            .buttonStyle(.bordered)
                    }
                } else {
                    Text(Format.clock(recorder.recording?.duration(at: context.date) ?? 0))
                        .font(.system(size: 64, weight: .semibold, design: .rounded).monospacedDigit())
                }
            }
            TimelineView(.periodic(from: .now, by: 1)) { context in
                let fresh = monitor.lastReading.map { context.date.timeIntervalSince($0) < 5 } ?? false
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "heart.fill").foregroundStyle(fresh ? Color.red : Color.secondary)
                    Text(fresh ? "\(monitor.bpm ?? 0)" : "--")
                        .font(.system(size: 88, weight: .bold, design: .rounded).monospacedDigit())
                    Text("bpm").foregroundStyle(.secondary)
                }
            }
            HStack(spacing: 40) {
                Stat(label: "Average", value: recorder.recording?.average.map { "\(Int($0.rounded()))" } ?? "--")
                Stat(label: "Max", value: recorder.recording?.maximum.map(String.init) ?? "--")
                Stat(label: "Readings", value: "\(recorder.recording?.count ?? 0)")
            }
            StrapStatusRow()
                .padding(.horizontal)
                .font(.footnote)
            Spacer()
            Button(role: .destructive) { confirmingEnd = true } label: {
                Label(isWaiting ? "Cancel" : "End", systemImage: isWaiting ? "xmark" : "stop.fill")
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .padding(.horizontal)
            .padding(.bottom)
            .confirmationDialog(isWaiting ? "Cancel this workout?" : "End this workout?",
                                isPresented: $confirmingEnd, titleVisibility: .visible) {
                if isWaiting {
                    Button("Cancel workout", role: .destructive, action: recorder.discard)
                    Button("Keep waiting", role: .cancel) {}
                } else {
                    Button("End workout", role: .destructive, action: recorder.end)
                    Button("Keep recording", role: .cancel) {}
                }
            }
        }
    }

    private var isWaiting: Bool { recorder.recording?.waiting() ?? false }
}

private struct Stat: View {
    let label: String
    let value: String

    var body: some View {
        VStack {
            Text(value).font(.title2.monospacedDigit().bold())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: - After

private struct ReviewView: View {
    @EnvironmentObject private var recorder: WorkoutRecorder
    @State private var confirmingDiscard = false

    var body: some View {
        List {
            if let message = recorder.message {
                Section { Text(message).foregroundStyle(.secondary) }
            }
            if let rec = recorder.recording {
                Section {
                    Picker("Activity", selection: Binding(get: { rec.activity }, set: recorder.setActivity)) {
                        ForEach(RecordedActivity.allCases) { Text($0.label).tag($0) }
                    }
                    LabeledContent("Started", value: rec.start.formatted(date: .abbreviated, time: .shortened))
                    LabeledContent("Duration", value: Format.clock(rec.duration()))
                    LabeledContent("Average HR", value: rec.average.map { "\(Int($0.rounded())) bpm" } ?? "—")
                    LabeledContent("Max HR", value: rec.maximum.map { "\($0) bpm" } ?? "—")
                    LabeledContent("Readings", value: coverage(rec))
                    if let strap = rec.strap?.name { LabeledContent("Strap", value: strap) }
                }
                Section {
                    Button {
                        Task { await recorder.save() }
                    } label: {
                        HStack {
                            Label("Save to Health", systemImage: "heart.text.square")
                            Spacer()
                            if recorder.phase == .saving { ProgressView() }
                        }
                    }
                    .disabled(recorder.phase == .saving)
                    Button("Resume recording", action: recorder.resume)
                        .disabled(recorder.phase == .saving)
                } footer: {
                    Text("Saved to Health with its heart rate, then sent to the server by the normal sync.")
                }
                Section {
                    Button("Discard", role: .destructive) { confirmingDiscard = true }
                        .disabled(recorder.phase == .saving)
                }
            }
        }
        .confirmationDialog("Discard this recording?", isPresented: $confirmingDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive, action: recorder.discard)
        }
    }

    private func coverage(_ rec: Recording) -> String {
        guard let share = rec.coverage else { return "\(rec.count)" }
        return "\(rec.count) (\(Int((share * 100).rounded()))% of seconds)"
    }
}

// MARK: - Over the dashboard

/// Shown over the dashboard while a recording runs or waits for Save; tap to open it.
struct RecordingBar: View {
    @EnvironmentObject private var recorder: WorkoutRecorder
    @EnvironmentObject private var monitor: HeartRateMonitor

    var body: some View {
        Button { recorder.screenShown = true } label: {
            HStack(spacing: 12) {
                Image(systemName: recorder.phase == .recording ? "record.circle" : "square.and.arrow.down")
                    .foregroundStyle(.red)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if let rec = recorder.recording, rec.waiting(at: context.date) {
                        Text("\(rec.activity.label) starts in \(Format.clock(rec.start.timeIntervalSince(context.date)))")
                    } else if recorder.phase == .recording {
                        Text("\(recorder.recording?.activity.label ?? "Workout") · \(Format.clock(recorder.recording?.duration(at: context.date) ?? 0))")
                    } else {
                        Text("Workout not saved yet — tap to save")
                    }
                }
                .monospacedDigit()
                Spacer()
                if recorder.phase == .recording, let bpm = monitor.bpm {
                    Text("\(bpm) bpm").monospacedDigit().bold()
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.regularMaterial, in: Capsule())
            .padding(.horizontal)
        }
        .buttonStyle(.plain)
    }
}

/// The round button over the dashboard that opens the record screen.
struct RecordButton: View {
    @EnvironmentObject private var recorder: WorkoutRecorder

    var body: some View {
        Button(action: recorder.open) {
            Image(systemName: "heart.circle.fill")
                .font(.system(size: 30))
                .symbolRenderingMode(.multicolor)
                .padding(12)
                .background(.regularMaterial, in: Circle())
                .shadow(radius: 3)
        }
        .accessibilityLabel("Record a workout")
    }
}

enum Format {
    static func clock(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        return s >= 3600
            ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
            : String(format: "%d:%02d", s / 60, s % 60)
    }
}
