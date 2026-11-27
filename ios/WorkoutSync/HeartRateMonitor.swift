import CoreBluetooth
import Foundation

/// What the recorder stores about the strap, so the samples in Health say where they came from.
struct StrapInfo: Codable, Equatable {
    var identifier: String
    var name: String?
    var manufacturer: String?
    var model: String?
    var firmware: String?
    var hardware: String?
}

/// A Bluetooth heart-rate strap (any device with the standard Heart Rate service — the
/// Polar OH1 included), connected directly by this app: no Polar Flow in between.
///
/// - The chosen strap is remembered; while the monitor is active it reconnects on its own
///   whenever the strap comes back in range. A pending `connect` has no timeout and keeps
///   working in the background, which is what carries a recording through a dropout.
/// - Only connected while active (the record screen is open, or a recording runs), so the
///   strap's battery is not drained by an idle connection.
/// - Background: `bluetooth-central` mode keeps notifications arriving with the phone locked;
///   state restoration lets iOS relaunch the app for the strap if it was evicted mid-session
///   (not after a swipe-away — iOS treats that as "stop").
@MainActor
final class HeartRateMonitor: NSObject, ObservableObject {
    enum Status: Equatable {
        case inactive
        case unavailable(String)
        case noStrap
        case searching
        case connecting(String)
        case connected(String)
    }

    struct Found: Identifiable, Equatable {
        let id: UUID
        let name: String
        var rssi: Int
    }

    @Published private(set) var status: Status = .inactive
    @Published private(set) var bpm: Int?
    @Published private(set) var contact: Bool?
    @Published private(set) var battery: Int?
    @Published private(set) var found: [Found] = []
    @Published private(set) var strap: StrapInfo?
    @Published private(set) var scanning = false
    /// Time of the last usable reading; the screen greys the number when it goes stale.
    @Published private(set) var lastReading: Date?

    /// Every usable reading, with the time it arrived.
    var onReading: ((Date, Int) -> Void)?

    private static let heartRateService = CBUUID(string: "180D")
    private static let measurement = CBUUID(string: "2A37")
    private static let batteryService = CBUUID(string: "180F")
    private static let batteryLevel = CBUUID(string: "2A19")
    private static let deviceInfo = CBUUID(string: "180A")
    private static let manufacturerName = CBUUID(string: "2A29")
    private static let modelNumber = CBUUID(string: "2A24")
    private static let firmwareRevision = CBUUID(string: "2A26")
    private static let hardwareRevision = CBUUID(string: "2A27")
    private static let savedKey = "heartRateStrapID"
    private static let restoreID = "workout-sync-hr-strap"

    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var active = false
    private var candidates: [UUID: CBPeripheral] = [:]

    private var savedID: UUID? {
        get { UserDefaults.standard.string(forKey: Self.savedKey).flatMap(UUID.init(uuidString:)) }
        set { UserDefaults.standard.set(newValue?.uuidString, forKey: Self.savedKey) }
    }

    var hasSavedStrap: Bool { savedID != nil }

    /// Connects to the remembered strap (the first call shows the Bluetooth permission prompt).
    func activate() {
        active = true
        if central == nil {
            central = CBCentralManager(delegate: self, queue: .main, options: [
                CBCentralManagerOptionRestoreIdentifierKey: Self.restoreID,
                CBCentralManagerOptionShowPowerAlertKey: true,
            ])
        } else {
            reconnect()
        }
    }

    /// Drops the connection so the strap is not kept busy between workouts.
    func deactivate() {
        active = false
        stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        bpm = nil
        contact = nil
        status = .inactive
    }

    func scan() {
        guard let central, central.state == .poweredOn else { return }
        found = []
        candidates = [:]
        scanning = true
        if peripheral == nil { status = .searching }
        central.scanForPeripherals(withServices: [Self.heartRateService])
        // Also offer a strap another app on the phone is already connected to.
        for p in central.retrieveConnectedPeripherals(withServices: [Self.heartRateService]) {
            remember(p, rssi: 0)
        }
    }

    func stopScan() {
        central?.stopScan()
        scanning = false
    }

    func choose(_ id: UUID) {
        guard let central, let p = candidates[id] else { return }
        stopScan()
        if let old = peripheral, old.identifier != id { central.cancelPeripheralConnection(old) }
        savedID = id
        connect(p)
    }

    func forget() {
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        peripheral = nil
        savedID = nil
        strap = nil
        bpm = nil
        battery = nil
        status = .noStrap
    }

    // MARK: -

    private func reconnect() {
        guard active, let central else { return }
        switch central.state {
        case .poweredOn: break
        case .unauthorized:
            status = .unavailable("Bluetooth access is off for Workout Sync — Settings → Workout Sync → Bluetooth.")
            return
        case .poweredOff:
            status = .unavailable("Bluetooth is off.")
            return
        case .unsupported:
            status = .unavailable("This device has no Bluetooth LE.")
            return
        default:
            return
        }
        if let peripheral, peripheral.state == .connected {
            peripheral.delegate = self
            status = .connected(displayName(peripheral))
            peripheral.discoverServices([Self.heartRateService, Self.batteryService, Self.deviceInfo])
            return
        }
        guard let savedID else {
            status = .noStrap
            scan()
            return
        }
        let known = peripheral.map { [$0] } ?? central.retrievePeripherals(withIdentifiers: [savedID])
        if let p = known.first(where: { $0.identifier == savedID }) {
            connect(p)
        } else {
            // Not known to this phone any more (Bluetooth reset): find it again.
            status = .searching
            scan()
        }
    }

    private func connect(_ p: CBPeripheral) {
        peripheral = p
        p.delegate = self
        status = .connecting(displayName(p))
        central?.connect(p)
    }

    private func remember(_ p: CBPeripheral, rssi: Int) {
        candidates[p.identifier] = p
        let entry = Found(id: p.identifier, name: displayName(p), rssi: rssi)
        if let i = found.firstIndex(where: { $0.id == p.identifier }) {
            found[i] = entry
        } else {
            found.append(entry)
        }
        // The remembered strap turned up again after a Bluetooth reset: take it.
        if p.identifier == savedID, peripheral == nil || peripheral?.state != .connected {
            stopScan()
            connect(p)
        }
    }

    private func displayName(_ p: CBPeripheral) -> String { p.name ?? "Heart-rate strap" }

    private func handle(_ characteristic: CBCharacteristic, of p: CBPeripheral) {
        guard let data = characteristic.value else { return }
        switch characteristic.uuid {
        case Self.measurement:
            guard let reading = HeartRateMeasurement.parse(data) else { return }
            contact = reading.contact
            guard HeartRateMeasurement.usable(reading) else {
                bpm = nil
                return
            }
            let now = Date()
            bpm = reading.bpm
            lastReading = now
            onReading?(now, reading.bpm)
        case Self.batteryLevel:
            battery = data.first.map(Int.init)
        case Self.manufacturerName:
            strap?.manufacturer = String(decoding: data, as: UTF8.self)
        case Self.modelNumber:
            strap?.model = String(decoding: data, as: UTF8.self)
        case Self.firmwareRevision:
            strap?.firmware = String(decoding: data, as: UTF8.self)
        case Self.hardwareRevision:
            strap?.hardware = String(decoding: data, as: UTF8.self)
        default:
            break
        }
    }
}

extension HeartRateMonitor: CBCentralManagerDelegate {
    nonisolated func centralManagerDidUpdateState(_ central: CBCentralManager) {
        MainActor.assumeIsolated { reconnect() }
    }

    nonisolated func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
        MainActor.assumeIsolated {
            // iOS relaunched the app for the strap: carry on with it.
            active = true
            if let p = restored.first(where: { $0.identifier == savedID }) ?? restored.first {
                peripheral = p
                p.delegate = self
            }
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral,
                                    advertisementData: [String: Any], rssi RSSI: NSNumber) {
        MainActor.assumeIsolated { remember(p, rssi: RSSI.intValue) }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        MainActor.assumeIsolated {
            guard p.identifier == peripheral?.identifier else { return }
            if strap?.identifier != p.identifier {
                strap = StrapInfo(identifier: p.identifier.uuidString, name: p.name)
            }
            status = .connected(displayName(p))
            p.discoverServices([Self.heartRateService, Self.batteryService, Self.deviceInfo])
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            guard active, p.identifier == peripheral?.identifier else { return }
            connect(p)
        }
    }

    nonisolated func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        MainActor.assumeIsolated {
            guard p.identifier == peripheral?.identifier else { return }
            bpm = nil
            contact = nil
            // Out of range, or the strap slipped off and slept: wait for it to come back.
            if active { connect(p) } else { status = .inactive }
        }
    }
}

extension HeartRateMonitor: CBPeripheralDelegate {
    nonisolated func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        MainActor.assumeIsolated {
            for service in p.services ?? [] {
                switch service.uuid {
                case Self.heartRateService: p.discoverCharacteristics([Self.measurement], for: service)
                case Self.batteryService: p.discoverCharacteristics([Self.batteryLevel], for: service)
                case Self.deviceInfo:
                    p.discoverCharacteristics([Self.manufacturerName, Self.modelNumber,
                                               Self.firmwareRevision, Self.hardwareRevision], for: service)
                default: break
                }
            }
        }
    }

    nonisolated func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        MainActor.assumeIsolated {
            for c in service.characteristics ?? [] {
                switch c.uuid {
                case Self.measurement:
                    p.setNotifyValue(true, for: c)
                case Self.batteryLevel:
                    p.readValue(for: c)
                    if c.properties.contains(.notify) { p.setNotifyValue(true, for: c) }
                default:
                    p.readValue(for: c)
                }
            }
        }
    }

    nonisolated func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        MainActor.assumeIsolated {
            guard error == nil else { return }
            handle(characteristic, of: p)
        }
    }
}
