// The menu bar side of Quillmeter: preferences the person can change in Settings, the compact text shown in the
// menu bar, and the rows (label, value, small bar) shown in the dropdown.
import AppKit

// MARK: - Preferences (UserDefaults; the Settings page changes them through the native bridge)

enum Prefs {
    static let d = UserDefaults.standard
    /// The figures that can appear in the menu bar, in the order they are shown.
    static let allMetrics = ["cpu", "memory", "network", "gpu", "battery", "disk"]
    static let metricNames = ["cpu": "CPU", "memory": "Memory", "network": "Network", "gpu": "GPU", "battery": "Battery", "disk": "Disk free"]

    static var metrics: [String] {
        get { let m = (d.stringArray(forKey: "mb.metrics") ?? ["cpu", "memory"]).filter { allMetrics.contains($0) }; return allMetrics.filter(m.contains) }
        set { d.set(allMetrics.filter(newValue.contains), forKey: "mb.metrics") }
    }
    static var showIcon: Bool { get { d.object(forKey: "mb.icon") as? Bool ?? true } set { d.set(newValue, forKey: "mb.icon") } }

    static var clipEnabled: Bool { get { d.bool(forKey: "cb.enabled") } set { d.set(newValue, forKey: "cb.enabled") } }
    static var clipLimit: Int { get { let v = d.integer(forKey: "cb.limit"); return [10, 25, 50, 100].contains(v) ? v : 25 } set { d.set(newValue, forKey: "cb.limit") } }
    static var clipPersist: Bool { get { d.bool(forKey: "cb.persist") } set { d.set(newValue, forKey: "cb.persist") } }
    static var clipExpire: Int { get { let v = d.integer(forKey: "cb.expire"); return [0, 1, 24, 168].contains(v) ? v : 0 } set { d.set(newValue, forKey: "cb.expire") } }
}

// MARK: - Figures

struct Metric {
    let id: String
    let name: String
    let short: String          // the small label in the menu bar
    let bar: Double?           // 0...1, nil when there is no natural scale
    let value: String          // the text in the dropdown
    let compact: String        // the text in the menu bar
    let hot: Bool
}

func compactBytes(_ n: Double) -> String { bytes(n).replacingOccurrences(of: " ", with: "") }

func metrics(from s: Snap) -> [String: Metric] {
    var out: [String: Metric] = [:]
    let cpuHot = s.cpu.total >= 85
    out["cpu"] = Metric(id: "cpu", name: "CPU", short: "CPU", bar: min(s.cpu.total / 100, 1), value: String(format: "%.0f%%  ·  %d cores", s.cpu.total, s.cpu.cores), compact: String(format: "%.0f%%", s.cpu.total), hot: cpuHot)
    let memHot = s.memory.pressure == "critical"
    out["memory"] = Metric(id: "memory", name: "Memory", short: "MEM", bar: s.memory.total > 0 ? min(s.memory.used / s.memory.total, 1) : nil,
                           value: "\(bytes(s.memory.used)) of \(bytes(s.memory.total))  ·  \(s.memory.pressure)", compact: compactBytes(s.memory.used), hot: memHot)
    out["network"] = Metric(id: "network", name: "Network", short: "NET", bar: nil, value: "↓ \(bytes(s.network.down))/s   ↑ \(bytes(s.network.up))/s",
                            compact: "↓\(compactBytes(s.network.down)) ↑\(compactBytes(s.network.up))", hot: false)
    if let g = s.gpu, g.present, let u = g.util {
        out["gpu"] = Metric(id: "gpu", name: "GPU", short: "GPU", bar: Double(u) / 100, value: "\(u)%", compact: "\(u)%", hot: u >= 95)
    }
    if s.battery.present, let p = s.battery.percent {
        let low = p <= 15 && (s.battery.state ?? "").lowercased().contains("discharg")
        out["battery"] = Metric(id: "battery", name: "Battery", short: "BAT", bar: Double(p) / 100,
                                value: "\(p)%" + (s.battery.state.map { "  ·  \($0)" } ?? "") + (s.battery.remaining.map { "  ·  \($0) left" } ?? ""), compact: "\(p)%", hot: low)
    }
    out["disk"] = Metric(id: "disk", name: "Disk", short: "DSK", bar: s.disk.total > 0 ? min(max((s.disk.total - s.disk.free) / s.disk.total, 0), 1) : nil,
                         value: "\(bytes(s.disk.free)) free", compact: compactBytes(s.disk.free), hot: s.disk.total > 0 && s.disk.free / s.disk.total < 0.05)
    return out
}

/// The menu bar text: small gray labels with the value after each. One figure shows the value alone.
func menuBarTitle(_ m: [String: Metric], chosen: [String]) -> (NSAttributedString, hot: Bool) {
    let items = chosen.compactMap { m[$0] }
    let out = NSMutableAttributedString()
    let valueFont = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    let labelFont = NSFont.systemFont(ofSize: 9, weight: .semibold)
    for (i, it) in items.enumerated() {
        if i > 0 { out.append(NSAttributedString(string: "  ", attributes: [.font: valueFont])) }
        if items.count > 1 { out.append(NSAttributedString(string: it.short + " ", attributes: [.font: labelFont, .foregroundColor: NSColor.secondaryLabelColor, .baselineOffset: 0.5])) }
        out.append(NSAttributedString(string: it.compact, attributes: [.font: valueFont, .foregroundColor: it.hot ? NSColor.systemRed : NSColor.labelColor]))
    }
    return (out, items.contains { $0.hot })
}

// MARK: - A dropdown row: name, value, and a small bar

final class MetricRowView: NSView {
    private let m: Metric
    init(_ m: Metric) {
        self.m = m
        super.init(frame: NSRect(x: 0, y: 0, width: 300, height: m.bar == nil ? 24 : 32))
    }
    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let pad: CGFloat = 14
        let name = NSAttributedString(string: m.name, attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.secondaryLabelColor])
        let val = NSAttributedString(string: m.value, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular), .foregroundColor: m.hot ? NSColor.systemRed : NSColor.labelColor])
        let top = bounds.height - 18
        name.draw(at: NSPoint(x: pad, y: top))
        val.draw(at: NSPoint(x: bounds.width - pad - val.size().width, y: top))
        if let f = m.bar {
            let track = NSRect(x: pad, y: 6, width: bounds.width - pad * 2, height: 3)
            NSColor.quaternaryLabelColor.setFill()
            NSBezierPath(roundedRect: track, xRadius: 1.5, yRadius: 1.5).fill()
            let fill = NSRect(x: track.minX, y: track.minY, width: max(3, track.width * CGFloat(f)), height: 3)
            (m.hot ? NSColor.systemRed : NSColor.controlAccentColor).setFill()
            NSBezierPath(roundedRect: fill, xRadius: 1.5, yRadius: 1.5).fill()
        }
    }
}
