// qm-trash: moves the given paths to the Trash (with "Put Back" support) and prints one JSON line per path.
// It makes no decisions about what is safe to move: the Quillmeter server validates every path first.
// Usage: qm-trash <absolute path>...
import Foundation

let home = FileManager.default.homeDirectoryForCurrentUser.path
// A last line of defence: never touch roots, the home folder or the top level of the disk.
func refuse(_ p: String) -> String? {
    guard p.hasPrefix("/") else { return "not an absolute path" }
    let std = (p as NSString).standardizingPath
    if std == "/" || std == home || std == "/Users" || std == "/Applications" || std == "/Library" || std == "/System" { return "protected location" }
    if std.split(separator: "/").count < 2 { return "too close to the root" }
    return nil
}
func line(_ d: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: d), let s = String(data: data, encoding: .utf8) { print(s) }
}

for p in CommandLine.arguments.dropFirst() {
    if let why = refuse(p) { line(["path": p, "ok": false, "error": why]); continue }
    var out: NSURL?
    do {
        try FileManager.default.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: &out)
        line(["path": p, "ok": true, "trashed": out?.path ?? ""])
    } catch {
        line(["path": p, "ok": false, "error": error.localizedDescription])
    }
}
