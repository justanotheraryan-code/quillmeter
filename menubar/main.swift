// Vitals menu bar item. A small native AppKit app that reads the local Vitals server
// (http://127.0.0.1:4747 by default, VITALS_URL to change) and shows CPU and memory in the menu bar.
// Click it for every figure and the busiest apps. `VitalsMenu --print` prints what it would show and exits.
import AppKit
import Foundation

let base = URL(string: ProcessInfo.processInfo.environment["VITALS_URL"] ?? "http://127.0.0.1:4747")!

struct Snap: Decodable {
    struct CPU: Decodable { let total: Double; let cores: Int }
    struct Mem: Decodable { let used: Double; let total: Double; let pressure: String }
    struct Disk: Decodable { let free: Double; let total: Double }
    struct Net: Decodable { let down: Double; let up: Double }
    struct Bat: Decodable { let present: Bool; let percent: Int?; let state: String?; let remaining: String? }
    struct GPU: Decodable { let present: Bool; let util: Int? }
    struct App: Decodable { let name: String; let cpu: Double; let mem: Double; let count: Int }
    let cpu: CPU
    let memory: Mem
    let disk: Disk
    let network: Net
    let battery: Bat
    let gpu: GPU?
    let apps: [App]
}

func bytes(_ n: Double) -> String {
    let units = ["B", "kB", "MB", "GB", "TB"]
    var v = n, i = 0
    while v >= 1000 && i < units.count - 1 { v /= 1000; i += 1 }
    let digits = (v >= 100 || i == 0) ? "%.0f" : (i >= 3 ? "%.2f" : "%.1f")
    return String(format: digits, v) + " " + units[i]
}

/// The text for the menu bar plus the lines of the dropdown. Shared by the GUI and `--print`.
func describe(_ s: Snap) -> (title: String, hot: Bool, lines: [String], busiest: [String]) {
    let hot = s.cpu.total >= 85 || s.memory.pressure == "critical"
    let title = String(format: "CPU %.0f%%  MEM %@", s.cpu.total, bytes(s.memory.used))
    var lines = [
        String(format: "CPU  %.0f%%  (%d cores)", s.cpu.total, s.cpu.cores),
        "Memory  \(bytes(s.memory.used)) of \(bytes(s.memory.total)), \(s.memory.pressure)",
        "Disk  \(bytes(s.disk.free)) free",
        "Network  ↓ \(bytes(s.network.down))/s   ↑ \(bytes(s.network.up))/s",
    ]
    if let g = s.gpu, g.present, let u = g.util { lines.append("GPU  \(u)%") }
    if s.battery.present, let p = s.battery.percent {
        lines.append("Battery  \(p)%  \(s.battery.state ?? "")" + (s.battery.remaining.map { "  \($0) left" } ?? ""))
    }
    let busiest = s.apps.sorted { $0.cpu > $1.cpu }.prefix(3).map {
        String(format: "%@  %.1f%%  ·  %@", $0.name, $0.cpu, bytes($0.mem))
    }
    return (title, hot, lines, Array(busiest))
}

func fetch(_ done: @escaping (Snap?) -> Void) {
    var req = URLRequest(url: base.appendingPathComponent("api/snapshot"))
    req.timeoutInterval = 3
    URLSession.shared.dataTask(with: req) { data, _, _ in
        done(data.flatMap { try? JSONDecoder().decode(Snap.self, from: $0) })
    }.resume()
}

if CommandLine.arguments.contains("--print") {
    let sem = DispatchSemaphore(value: 0)
    var out: Snap?
    fetch { out = $0; sem.signal() }
    _ = sem.wait(timeout: .now() + 5)
    guard let s = out else { FileHandle.standardError.write(Data("Vitals is not reachable at \(base.absoluteString)\n".utf8)); exit(1) }
    let d = describe(s)
    print("title: \(d.title)\(d.hot ? "  [red]" : "")")
    d.lines.forEach { print("  \($0)") }
    print("busiest:")
    d.busiest.forEach { print("  \($0)") }
    exit(0)
}

final class Controller: NSObject, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var snap: Snap?

    override init() {
        super.init()
        menu.delegate = self
        item.menu = menu
        setTitle("Vitals…", hot: false)
        tick()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
    }

    func setTitle(_ text: String, hot: Bool) {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: hot ? NSColor.systemRed : NSColor.labelColor,
        ]
        item.button?.attributedTitle = NSAttributedString(string: text, attributes: attrs)
    }

    func tick() {
        fetch { [weak self] s in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.snap = s
                if let s = s { let d = describe(s); self.setTitle(d.title, hot: d.hot) }
                else { self.setTitle("Vitals: offline", hot: false) }
            }
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        menu.removeAllItems()
        func label(_ text: String, bold: Bool = false) {
            let m = NSMenuItem(title: text, action: nil, keyEquivalent: "")
            m.isEnabled = false
            m.attributedTitle = NSAttributedString(string: text, attributes: [
                .font: bold ? NSFont.boldSystemFont(ofSize: 12) : NSFont.menuFont(ofSize: 13),
                .foregroundColor: bold ? NSColor.secondaryLabelColor : NSColor.labelColor,
            ])
            menu.addItem(m)
        }
        if let s = snap {
            let d = describe(s)
            d.lines.forEach { label($0) }
            menu.addItem(.separator())
            label("Busiest right now", bold: true)
            d.busiest.forEach { label($0) }
        } else {
            label("Vitals is not running. Start it with service/service.sh install.")
        }
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open Vitals", action: #selector(openVitals), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        let quit = NSMenuItem(title: "Quit Vitals Menu", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    @objc func openVitals() { NSWorkspace.shared.open(base) }
    @objc func quitApp() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // menu bar only: no Dock icon
let controller = Controller()
app.run()
