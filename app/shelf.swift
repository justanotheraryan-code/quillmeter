// The shelf: a small floating window that holds files and text for a moment, so you can pick them up from one place and
// drop them in another. Off until turned on in Settings. Drop files or text onto it; drag a row out to use it.
//
// What it keeps: the location of each file (never a copy or the contents) and the text of each snippet, in memory only.
// Nothing is saved to disk, and quitting forgets everything. A row leaves the shelf after it is dragged out and dropped
// somewhere; the x button removes one without using it, and Clear removes them all.
import AppKit

struct ShelfItem: Equatable {
    enum Kind { case file, text }
    let id = UUID()
    let kind: Kind
    let value: String            // a path for a file, the text for a snippet
    var title: String {
        switch kind {
        case .file: return (value as NSString).lastPathComponent
        case .text: return ClipboardStore.title(value, max: 40)
        }
    }
    static func == (a: ShelfItem, b: ShelfItem) -> Bool { a.id == b.id }
}

/// The list itself, with no window attached.
final class ShelfModel {
    static let maxItems = 50
    static let maxChars = 20_000
    private(set) var items: [ShelfItem] = []
    var onChange: (() -> Void)?

    func addFiles(_ paths: [String]) {
        for p in paths where !items.contains(where: { $0.kind == .file && $0.value == p }) { items.insert(ShelfItem(kind: .file, value: p), at: 0) }
        trim()
    }
    func addText(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= Self.maxChars, !items.contains(where: { $0.kind == .text && $0.value == text }) else { return }
        items.insert(ShelfItem(kind: .text, value: text), at: 0)
        trim()
    }
    func remove(_ id: UUID) { items.removeAll { $0.id == id }; onChange?() }
    func clear() { items = []; onChange?() }
    /// Drop files that no longer exist (moved or deleted since they were added).
    func prune() { let n = items.count; items.removeAll { $0.kind == .file && !FileManager.default.fileExists(atPath: $0.value) }; if items.count != n { onChange?() } }
    private func trim() { if items.count > Self.maxItems { items = Array(items.prefix(Self.maxItems)) }; onChange?() }
}

// MARK: - One row: an icon, a title, and a remove button. Dragging the row drags the file or text out.

final class ShelfRow: NSView, NSDraggingSource {
    let item: ShelfItem
    var onRemove: ((UUID) -> Void)?
    var onUsed: ((UUID) -> Void)?
    private let icon = NSImageView()
    private let label = NSTextField(labelWithString: "")
    private let close = NSButton()
    private var down: NSPoint?

    init(_ item: ShelfItem) {
        self.item = item
        super.init(frame: NSRect(x: 0, y: 0, width: 280, height: 36))
        icon.image = Self.icon(for: item)
        icon.imageScaling = .scaleProportionallyUpOrDown
        label.stringValue = item.title
        label.lineBreakMode = .byTruncatingMiddle
        label.font = .systemFont(ofSize: 13)
        label.toolTip = item.kind == .file ? item.value : String(item.value.prefix(400))
        close.bezelStyle = .inline
        close.isBordered = false
        close.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Remove from shelf")
        close.contentTintColor = .tertiaryLabelColor
        close.target = self; close.action = #selector(removeTapped)
        for v in [icon, label, close] { v.translatesAutoresizingMaskIntoConstraints = false; addSubview(v) }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 36),
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10), icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 22), icon.heightAnchor.constraint(equalToConstant: 22),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8), label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.trailingAnchor.constraint(equalTo: close.leadingAnchor, constant: -6),
            close.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8), close.centerYAnchor.constraint(equalTo: centerYAnchor),
            close.widthAnchor.constraint(equalToConstant: 18), close.heightAnchor.constraint(equalToConstant: 18),
        ])
        setAccessibilityLabel(item.title); setAccessibilityRole(.group)
    }
    required init?(coder: NSCoder) { nil }

    static func icon(for item: ShelfItem) -> NSImage {
        switch item.kind {
        case .file: let i = NSWorkspace.shared.icon(forFile: item.value); i.size = NSSize(width: 22, height: 22); return i
        case .text: return NSImage(systemSymbolName: "text.alignleft", accessibilityDescription: "Text") ?? NSImage()
        }
    }

    @objc func removeTapped() { onRemove?(item.id) }

    /// What is put on the drag pasteboard: the file's URL, or the text.
    var writer: NSPasteboardWriting {
        item.kind == .file ? URL(fileURLWithPath: item.value) as NSURL : item.value as NSString
    }

    override func mouseDown(with event: NSEvent) {
        down = event.locationInWindow
        if event.clickCount == 2 {                                  // double-click: show the file, or copy the text
            switch item.kind {
            case .file: NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: item.value)])
            case .text: let pb = NSPasteboard.general; pb.clearContents(); pb.setString(item.value, forType: .string)
            }
        }
    }
    override func mouseDragged(with event: NSEvent) {
        guard let start = down, hypot(event.locationInWindow.x - start.x, event.locationInWindow.y - start.y) > 4 else { return }
        down = nil
        let d = NSDraggingItem(pasteboardWriter: writer)
        d.setDraggingFrame(NSRect(x: 0, y: 0, width: 24, height: 24), contents: Self.icon(for: item))
        beginDraggingSession(with: [d], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? [.copy, .link, .generic] : []   // dragging within the shelf itself does nothing
    }
    func draggingSession(_ session: NSDraggingSession, endedAt point: NSPoint, operation: NSDragOperation) {
        if operation != [] { onUsed?(item.id) }                          // it was dropped somewhere: it leaves the shelf
    }
}

// MARK: - The window

final class ShelfController: NSObject {
    let model = ShelfModel()
    private var panel: NSPanel?
    private let stack = NSStackView()
    private let empty = NSTextField(wrappingLabelWithString: "Drop files or text here.\nDrag a row out to use it. It leaves the shelf once dropped.")
    private let clearButton = NSButton(title: "Clear", target: nil, action: nil)
    private(set) var rowCount = 0

    override init() {
        super.init()
        model.onChange = { [weak self] in self?.reload() }
    }

    var isOpen: Bool { panel?.isVisible ?? false }

    func show() {
        if panel == nil { build() }
        model.prune(); reload()
        panel?.orderFrontRegardless()
    }
    func hide() { panel?.orderOut(nil) }
    /// Turned off in Settings: close the window and forget everything.
    func shutDown() { hide(); model.clear() }

    private func build() {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 300, height: 320),
                        styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel], backing: .buffered, defer: false)
        p.title = "Shelf"
        p.isFloatingPanel = true
        p.level = .floating
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.minSize = NSSize(width: 240, height: 160)
        p.setFrameAutosaveName("QuillmeterShelf")
        if !p.setFrameUsingName("QuillmeterShelf") {
            if let s = NSScreen.main?.visibleFrame { p.setFrameOrigin(NSPoint(x: s.maxX - 320, y: s.midY - 160)) }
        }

        let drop = ShelfDropView(frame: p.contentRect(forFrameRect: p.frame))
        drop.autoresizingMask = [.width, .height]
        drop.onFiles = { [weak self] in self?.model.addFiles($0) }
        drop.onText = { [weak self] in self?.model.addText($0) }

        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let doc = FlippedView(); doc.translatesAutoresizingMaskIntoConstraints = false
        doc.addSubview(stack)
        scroll.documentView = doc
        empty.textColor = .secondaryLabelColor; empty.alignment = .center; empty.translatesAutoresizingMaskIntoConstraints = false
        clearButton.target = self; clearButton.action = #selector(clearAll); clearButton.bezelStyle = .rounded
        clearButton.translatesAutoresizingMaskIntoConstraints = false

        for v in [scroll, empty, clearButton] { drop.addSubview(v) }
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: drop.topAnchor, constant: 6),
            scroll.leadingAnchor.constraint(equalTo: drop.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: drop.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: clearButton.topAnchor, constant: -6),
            clearButton.trailingAnchor.constraint(equalTo: drop.trailingAnchor, constant: -10), clearButton.bottomAnchor.constraint(equalTo: drop.bottomAnchor, constant: -10),
            empty.centerXAnchor.constraint(equalTo: drop.centerXAnchor), empty.centerYAnchor.constraint(equalTo: drop.centerYAnchor),
            empty.widthAnchor.constraint(lessThanOrEqualTo: drop.widthAnchor, constant: -40),
            doc.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor), doc.trailingAnchor.constraint(equalTo: scroll.contentView.trailingAnchor),
            doc.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            stack.topAnchor.constraint(equalTo: doc.topAnchor), stack.leadingAnchor.constraint(equalTo: doc.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: doc.trailingAnchor), stack.bottomAnchor.constraint(equalTo: doc.bottomAnchor),
        ])
        p.contentView = drop
        panel = p
    }

    private func reload() {
        guard panel != nil else { rowCount = model.items.count; return }
        for v in stack.arrangedSubviews { stack.removeArrangedSubview(v); v.removeFromSuperview() }
        for it in model.items {
            let row = ShelfRow(it)
            row.onRemove = { [weak self] id in self?.model.remove(id) }
            row.onUsed = { [weak self] id in self?.model.remove(id) }
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        rowCount = model.items.count
        empty.isHidden = !model.items.isEmpty
        clearButton.isEnabled = !model.items.isEmpty
        panel?.title = model.items.isEmpty ? "Shelf" : "Shelf  \u{00B7}  \(model.items.count)"
    }

    @objc private func clearAll() { model.clear() }
}

/// A flipped view so rows start at the top of the scroll area.
final class FlippedView: NSView { override var isFlipped: Bool { true } }

/// The window's content: accepts files and text dropped on it.
final class ShelfDropView: NSView {
    var onFiles: (([String]) -> Void)?
    var onText: ((String) -> Void)?

    override init(frame: NSRect) { super.init(frame: frame); registerForDraggedTypes([.fileURL, .string]) }
    required init?(coder: NSCoder) { nil }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { .copy }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pb = sender.draggingPasteboard
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            onFiles?(urls.map { $0.path }); return true
        }
        if let s = pb.string(forType: .string) { onText?(s); return true }
        return false
    }
}
