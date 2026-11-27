import Foundation

/// The Bluetooth Heart Rate Measurement characteristic (0x2A37), as every standard strap
/// sends it — the Polar OH1, H9/H10, Wahoo TICKR, Garmin HRM alike.
///
/// Byte 0 is flags: bit 0 = heart rate is UInt16 (else UInt8); bits 1–2 = sensor contact
/// (0/1 not supported, 2 supported but no contact, 3 contact); bit 3 = energy expended
/// (UInt16) follows; bit 4 = RR intervals (UInt16 each, 1/1024 s) fill the rest.
enum HeartRateMeasurement {
    struct Reading: Equatable {
        let bpm: Int
        /// nil when the strap does not report contact at all.
        let contact: Bool?
        /// Seconds between beats, when the strap sends them.
        let rrIntervals: [Double]
    }

    /// A reading outside this range is a strap glitch (0 is what some send with no skin contact).
    static let plausible = 25...240

    static func parse(_ data: Data) -> Reading? {
        let b = [UInt8](data)
        guard b.count >= 2 else { return nil }
        let flags = b[0]
        var i = 1
        let bpm: Int
        if flags & 0x01 != 0 {
            guard b.count >= 3 else { return nil }
            bpm = Int(b[1]) | Int(b[2]) << 8
            i = 3
        } else {
            bpm = Int(b[1])
            i = 2
        }
        let contactBits = (flags >> 1) & 0x03
        let contact: Bool? = contactBits == 3 ? true : (contactBits == 2 ? false : nil)
        if flags & 0x08 != 0 { i += 2 }
        var rr: [Double] = []
        if flags & 0x10 != 0 {
            while i + 1 < b.count {
                rr.append(Double(Int(b[i]) | Int(b[i + 1]) << 8) / 1024)
                i += 2
            }
        }
        return Reading(bpm: bpm, contact: contact, rrIntervals: rr)
    }

    /// Whether a reading belongs in a recording: in range, and not flagged as off the skin.
    static func usable(_ r: Reading) -> Bool {
        plausible.contains(r.bpm) && r.contact != false
    }
}
