// Quillmeter.app: the host for the Quillmeter dashboard.
//  - starts the bundled Node server (or attaches to one that is already running on the port) and stops it on quit
//  - shows the dashboard in a native window, plus a menu bar item with CPU and memory
//  - launch at login through SMAppService
// A Settings window (Command-,) shows the same dashboard in settings mode. Export Image uses a save panel, so no
// folder permission is needed. Flags: --background (no window at launch), --login on|off|status, --print, --selftest.
import AppKit
import WebKit
import ServiceManagement
import Foundation
import UniformTypeIdentifiers

let env = ProcessInfo.processInfo.environment
let port = Int(env["QUILLMETER_PORT"] ?? "") ?? 4747
let base = URL(string: "http://127.0.0.1:\(port)")!
let args = CommandLine.arguments
let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
let home = FileManager.default.homeDirectoryForCurrentUser

// MARK: - Launch at login

enum Login {
    static var status: SMAppService.Status { SMAppService.mainApp.status }
    static var enabled: Bool { status == .enabled }
    static var label: String {
        switch status {
        case .enabled: return "on"
        case .requiresApproval: return "needs approval"
        case .notRegistered: return "off"
        case .notFound: return "unavailable"
        @unknown default: return "unknown"
        }
    }
    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}

if let i = args.firstIndex(of: "--login") {
    let mode = i + 1 < args.count ? args[i + 1] : "status"
    do {
        if mode == "on" { try Login.set(true) } else if mode == "off" { try Login.set(false) }
        print("launch at login: \(Login.label)")
        exit(0)
    } catch {
        print("launch at login: \(error.localizedDescription) (status: \(Login.label))")
        exit(1)
    }
}

// MARK: - Snapshot (for the menu bar item)

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
    let busiest = s.apps.sorted { $0.cpu > $1.cpu }.prefix(3).map { String(format: "%@  %.1f%%  ·  %@", $0.name, $0.cpu, bytes($0.mem)) }
    return (title, hot, lines, Array(busiest))
}

func fetchSnapshot(_ done: @escaping (Snap?) -> Void) {
    var req = URLRequest(url: base.appendingPathComponent("api/snapshot"))
    req.timeoutInterval = 3
    URLSession.shared.dataTask(with: req) { data, _, _ in done(data.flatMap { try? JSONDecoder().decode(Snap.self, from: $0) }) }.resume()
}

if args.contains("--print") {
    let sem = DispatchSemaphore(value: 0)
    var out: Snap?
    fetchSnapshot { out = $0; sem.signal() }
    _ = sem.wait(timeout: .now() + 5)
    guard let s = out else { FileHandle.standardError.write(Data("Quillmeter is not reachable at \(base.absoluteString)\n".utf8)); exit(1) }
    let d = describe(s)
    print("title: \(d.title)\(d.hot ? "  [red]" : "")")
    d.lines.forEach { print("  \($0)") }
    d.busiest.forEach { print("  busiest: \($0)") }
    exit(0)
}

// MARK: - Bundled server

final class ServerManager {
    private var child: Process?
    private var quitting = false
    private var crashes = 0
    private(set) var weStarted = false
    private let logURL = home.appendingPathComponent(".quillmeter/app.log")

    /// True when something answering like Quillmeter is already on the port.
    func probe(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent("api/settings"))
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { data, _, _ in
            let j = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            done(j?["retentionDays"] != nil)
        }.resume()
    }

    /// Attach to a running server, or start the bundled one. Calls back on the main queue; nil means ready.
    func start(_ ready: @escaping (String?) -> Void) {
        probe { alive in
            DispatchQueue.main.async {
                if alive { self.weStarted = false; ready(nil); return }
                self.spawn()
                self.waitReady(deadline: Date().addingTimeInterval(25), ready)
            }
        }
    }

    private func waitReady(deadline: Date, _ ready: @escaping (String?) -> Void) {
        probe { alive in
            DispatchQueue.main.async {
                if alive { ready(nil) }
                else if Date() > deadline { ready("Quillmeter's server did not start. Details are in ~/.quillmeter/app.log.") }
                else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitReady(deadline: deadline, ready) } }
            }
        }
    }

    private func spawn() {
        guard let res = Bundle.main.resourceURL else { return }
        let script = res.appendingPathComponent("server/server.js")
        let p = Process()
        p.executableURL = res.appendingPathComponent("node")
        p.arguments = [script.path]
        p.currentDirectoryURL = script.deletingLastPathComponent()
        var e = env
        e["PORT"] = String(port)
        e["QUILLMETER_PARENT_PID"] = String(getpid()) // the server exits by itself if this app disappears
        e["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
        p.environment = e
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); p.standardOutput = h; p.standardError = h }
        p.terminationHandler = { [weak self] proc in DispatchQueue.main.async { self?.exited(proc) } }
        do { try p.run(); child = p; weStarted = true } catch { NSLog("could not start server: \(error)") }
    }

    private func exited(_ proc: Process) {
        guard !quitting, proc === child else { return }
        child = nil
        crashes += 1
        if crashes <= 5 { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { if !self.quitting { self.spawn() } } }
    }

    /// Stop the server only if this app started it. SIGTERM lets it flush history to disk first.
    func stop() {
        quitting = true
        guard weStarted, let c = child else { return }
        c.terminate()
        for _ in 0..<40 where c.isRunning { Thread.sleep(forTimeInterval: 0.1) }
    }
}

// MARK: - App

func fourCC(_ s: String) -> UInt32 { s.utf8.reduce(0) { ($0 << 8) | UInt32($1) } }

/// True when macOS started the app as a login item ('oapp' event carrying 'lgit'), so it can stay quiet.
func launchedAsLoginItem() -> Bool {
    guard let ev = NSAppleEventManager.shared().currentAppleEvent, ev.eventID == fourCC("oapp") else { return false }
    return ev.paramDescriptor(forKeyword: fourCC("prdt"))?.enumCodeValue == fourCC("lgit")
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate,
                         WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let server = ServerManager()
    let selfTest = args.contains("--selftest")
    var item: NSStatusItem?
    let statusMenu = NSMenu()
    let appMenu = NSMenu()
    var snap: Snap?
    var window: NSWindow?
    var web: WKWebView?
    var settingsWindow: NSWindow?
    var settingsWeb: WKWebView?
    var serverReady = false
    var targets: [ObjectIdentifier: URL] = [:]

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildMainMenu()
        if selfTest { runSelfTest(); return }
        setupStatusItem()
        server.start { err in
            if let err = err { self.alert("Quillmeter could not start", err); return }
            self.serverReady = true
            if let w = self.web { self.load(w, base) }
            if let w = self.settingsWeb { self.load(w, self.settingsURL(nil)) }
            self.pushNativeState()
        }
        if !args.contains("--background") && !launchedAsLoginItem() { showWindow() }
    }

    func applicationWillTerminate(_ n: Notification) { server.stop() }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows flag: Bool) -> Bool { if !flag { showWindow() }; return true }

    // MARK: Window

    func makeWebView(size: NSSize = NSSize(width: 1100, height: 820)) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "native")
        cfg.userContentController.addUserScript(WKUserScript(source: "window.quillmeterNative = \(nativeStateJSON());", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let w = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: cfg)
        w.navigationDelegate = self
        w.uiDelegate = self
        w.customUserAgent = "QuillmeterApp/\(appVersion)"
        w.loadHTMLString("<body style='font:13px -apple-system;color:#636366;padding:32px;background:#f5f5f7'>Starting Quillmeter…</body>", baseURL: nil)
        return w
    }

    func load(_ w: WKWebView, _ url: URL) { targets[ObjectIdentifier(w)] = url; w.load(URLRequest(url: url)) }
    func settingsURL(_ pane: String?) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "settings", value: "1")] + (pane.map { [URLQueryItem(name: "pane", value: $0)] } ?? [])
        return c.url!
    }

    func showWindow() {
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            w.title = "Quillmeter"
            w.minSize = NSSize(width: 520, height: 420)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.setFrameAutosaveName("QuillmeterMain")
            if !w.setFrameUsingName("QuillmeterMain") { w.center() }
            let v = makeWebView()
            w.contentView = v
            web = v
            window = w
            if serverReady { load(v, base) }
        }
        NSApp.setActivationPolicy(.regular) // Dock icon and menu while a window is open
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The Settings window: fixed size, no minimize or zoom (it opens instantly with Command-comma), restores its last pane.
    func showSettings(pane: String? = nil) {
        if let v = settingsWeb, settingsWindow != nil {
            if let p = pane { v.evaluateJavaScript("window.setPane && window.setPane('\(p)')", completionHandler: nil) }
        } else {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 640), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "Quillmeter Settings"
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.setFrameAutosaveName("QuillmeterSettings")
            if !w.setFrameUsingName("QuillmeterSettings") { w.center() }
            let v = makeWebView(size: NSSize(width: 600, height: 640))
            w.contentView = v
            settingsWeb = v
            settingsWindow = w
            if serverReady { load(v, settingsURL(pane)) }
        }
        NSApp.setActivationPolicy(.regular)
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func openSettingsMenu() { showSettings() }

    func windowWillClose(_ n: Notification) {
        // Back to a menu bar app once no window is left on screen.
        DispatchQueue.main.async {
            if !(self.window?.isVisible ?? false) && !(self.settingsWindow?.isVisible ?? false) { NSApp.setActivationPolicy(.accessory) }
        }
    }

    // MARK: Native bridge

    func nativeStateJSON() -> String {
        let d: [String: Any] = ["available": true, "launchAtLogin": Login.enabled, "status": Login.label]
        let data = (try? JSONSerialization.data(withJSONObject: d)) ?? Data("{}".utf8)
        return String(data: data, encoding: .utf8) ?? "{}"
    }
    func pushNativeState() { for v in [web, settingsWeb] { v?.evaluateJavaScript("window.onNativeState && window.onNativeState(\(nativeStateJSON()))", completionHandler: nil) } }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any] else { return }
        if let on = body["launchAtLogin"] as? Bool { setLogin(on) }
        if body["openSettings"] as? Bool == true { showSettings(pane: body["pane"] as? String) }
        if let data = body["saveImage"] as? String { saveImage(dataURL: data, name: (body["name"] as? String) ?? "quillmeter.png") }
    }

    /// Export Image: a save panel, so the person picks the place and macOS needs no folder permission.
    func saveImage(dataURL: String, name: String) {
        guard let comma = dataURL.firstIndex(of: ","), let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])) else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.nameFieldStringValue = (name as NSString).lastPathComponent
        panel.canCreateDirectories = true
        NSApp.activate(ignoringOtherApps: true)
        panel.begin { resp in
            guard resp == .OK, let url = panel.url else { return }
            do { try data.write(to: url); NSWorkspace.shared.activateFileViewerSelecting([url]) }
            catch { self.alert("Couldn\u{2019}t Save Image", error.localizedDescription) }
        }
    }

    func setLogin(_ on: Bool) {
        do { try Login.set(on) } catch { alert("Launch at login", error.localizedDescription) }
        if Login.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        pushNativeState()
    }
    @objc func toggleLogin() { setLogin(!Login.enabled) }

    // MARK: WebKit delegates

    func webView(_ w: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.cancel); return }
        if let url = action.request.url, (url.scheme == "http" || url.scheme == "https"), url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url) // external links open in the default browser
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        guard serverReady else { return }
        let url = targets[ObjectIdentifier(w)] ?? base
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { w.load(URLRequest(url: url)) } // server restarting: retry
    }

    // The page uses confirm() before quitting an app, which WKWebView only supports through this delegate.
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.runModal()
        completionHandler()
    }

    func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }

    // MARK: Menus

    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem); appItem.submenu = appMenu
        appMenu.delegate = self
        appMenu.addItem(withTitle: "About Quillmeter", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settingsItem = NSMenuItem(title: "Settings\u{2026}", action: #selector(openSettingsMenu), keyEquivalent: ","); settingsItem.target = self; appMenu.addItem(settingsItem)
        let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: ""); login.target = self; appMenu.addItem(login)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Quillmeter", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Quillmeter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View"); viewItem.submenu = view
        let side = NSMenuItem(title: "Hide or Show Sidebar", action: #selector(toggleSidebar), keyEquivalent: "s")
        side.keyEquivalentModifierMask = [.control, .command]; side.target = self; view.addItem(side)

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window"); winItem.submenu = win
        let reload = NSMenuItem(title: "Reload", action: #selector(reloadPage), keyEquivalent: "r"); reload.target = self; win.addItem(reload)
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        NSApp.mainMenu = main
    }
    @objc func reloadPage() { if let w = web { load(w, base) } }
    @objc func toggleSidebar() { web?.evaluateJavaScript("window.toggleSidebar && window.toggleSidebar()", completionHandler: nil) }

    func setupStatusItem() {
        let it = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        it.menu = statusMenu
        statusMenu.delegate = self
        item = it
        setTitle("Quillmeter…", hot: false)
        tick()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
    }

    func setTitle(_ text: String, hot: Bool) {
        item?.button?.attributedTitle = NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: hot ? NSColor.systemRed : NSColor.labelColor,
        ])
    }

    func tick() {
        guard serverReady else { return }
        fetchSnapshot { [weak self] s in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.snap = s
                if let s = s { let d = describe(s); self.setTitle(d.title, hot: d.hot) } else { self.setTitle("Quillmeter: offline", hot: false) }
            }
        }
    }

    func menuWillOpen(_ menu: NSMenu) {
        if menu === appMenu {
            appMenu.items.first { $0.action == #selector(toggleLogin) }?.state = Login.enabled ? .on : .off
            return
        }
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
        } else { label("Starting…") }
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open Quillmeter", action: #selector(openWindow), keyEquivalent: "o"); open.target = self; menu.addItem(open)
        let prefs = NSMenuItem(title: "Settings\u{2026}", action: #selector(openSettingsMenu), keyEquivalent: ","); prefs.target = self; menu.addItem(prefs)
        let browser = NSMenuItem(title: "Open in Browser", action: #selector(openBrowser), keyEquivalent: ""); browser.target = self; menu.addItem(browser)
        let login = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: ""); login.target = self
        login.state = Login.enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Quillmeter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); menu.addItem(quit)
    }
    @objc func openWindow() { showWindow() }
    @objc func openBrowser() { NSWorkspace.shared.open(base) }

    // MARK: Self test (no GUI interaction: loads the real page in an off-screen web view and reports what it found)

    func runSelfTest() {
        server.start { err in
            if let err = err { print("selftest: FAIL server: \(err)"); self.server.stop(); exit(1) }
            self.serverReady = true
            let v = self.makeWebView()
            self.web = v
            self.load(v, base)
            let sv = self.makeWebView(size: NSSize(width: 600, height: 640))
            self.settingsWeb = sv
            self.load(sv, self.settingsURL("folders"))
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                let js = "JSON.stringify({title: document.title, sidebarItems: document.querySelectorAll('.side-item').length, groups: document.querySelectorAll('.side-group:not(:empty)').length, setupSheet: !!document.querySelector('.sheet'), sheetFolders: document.querySelectorAll('.sheet [data-folder]').length, sheetChecked: document.querySelectorAll('.sheet [data-folder]:checked').length, native: !!window.quillmeterNative, host: document.getElementById('hostline').textContent})"
                let js2 = "JSON.stringify({mode: document.body.classList.contains('settings-mode'), title: document.getElementById('title').textContent, panes: document.querySelectorAll('[data-pane]').length, folderBoxes: document.querySelectorAll('[data-folder]').length})"
                // Glass: it loaded, refraction stays off in WebKit, and a pointer move over a control drives it.
                let glass1 = "(() => { const b = document.querySelector('.toolbar .icon-btn'); const r = b.getBoundingClientRect(); b.dispatchEvent(new PointerEvent('pointermove', {clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: 'mouse', bubbles: true})); return b.className; })()"
                let glass2 = "(() => { const b = document.querySelector('.toolbar .icon-btn'); return JSON.stringify({ready: document.body.classList.contains('glass-ready'), refract: document.body.classList.contains('refract'), glassElements: document.querySelectorAll('.glass').length, lens: !!document.querySelector('.lens'), lensPlaced: document.querySelector('.lens').style.height !== '', litControls: [...document.querySelectorAll('.glass')].filter(e => parseFloat(e.style.getPropertyValue('--fade') || 0) > 0).length, fade: b.style.getPropertyValue('--fade'), mx: b.style.getPropertyValue('--mx'), backdrop: getComputedStyle(document.querySelector('.sheet') || b).webkitBackdropFilter || getComputedStyle(b).backdropFilter}); })()"
                v.evaluateJavaScript(js) { r1, e1 in
                    sv.evaluateJavaScript(js2) { r2, e2 in
                        v.evaluateJavaScript(glass1) { _, _ in
                            DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) { // an off-screen web view throttles timers to about 1 s
                                v.evaluateJavaScript(glass2) { r3, e3 in
                                    print("selftest: version=\(appVersion) serverStartedByApp=\(self.server.weStarted) loginStatus=\(Login.label)")
                                    print("selftest: main=\(r1 as? String ?? "nil") error=\(e1?.localizedDescription ?? "none")")
                                    print("selftest: settings=\(r2 as? String ?? "nil") error=\(e2?.localizedDescription ?? "none")")
                                    print("selftest: glass=\(r3 as? String ?? "nil") error=\(e3?.localizedDescription ?? "none")")
                                    self.server.stop()
                                    exit(e1 == nil && e2 == nil && e3 == nil && r1 != nil && r2 != nil && r3 != nil ? 0 : 1)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
