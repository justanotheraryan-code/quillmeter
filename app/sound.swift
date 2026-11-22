// Sound for Quillmeter: pick the output and input device, set their volume and mute, and set the volume of a single
// app. Nothing here runs until the Sound tab is opened. Per-app volume uses Core Audio process taps (macOS 14.2 or
// later): a tap captures one app's audio, mutes the original, and plays it again at the volume you set. macOS asks
// for permission the first time (System Audio Recording). Setting an app back to 100% removes its tap.
import AppKit
import CoreAudio
import AudioToolbox

// MARK: - Small Core Audio helpers

enum HAL {
    static func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                     _ el: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: el)
    }
    static func has(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ el: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> Bool {
        var a = addr(sel, scope, el); return AudioObjectHasProperty(obj, &a)
    }
    static func settable(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope, _ el: AudioObjectPropertyElement) -> Bool {
        var a = addr(sel, scope, el); var s: DarwinBoolean = false
        return AudioObjectIsPropertySettable(obj, &a, &s) == noErr && s.boolValue
    }
    static func value<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ el: AudioObjectPropertyElement = kAudioObjectPropertyElementMain, _ zero: T) -> T? {
        var a = addr(sel, scope, el); var v = zero; var size = UInt32(MemoryLayout<T>.size)
        return AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v) == noErr ? v : nil
    }
    @discardableResult
    static func set<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ el: AudioObjectPropertyElement = kAudioObjectPropertyElementMain, _ v: T) -> Bool {
        var a = addr(sel, scope, el); var x = v
        return AudioObjectSetPropertyData(obj, &a, 0, nil, UInt32(MemoryLayout<T>.size), &x) == noErr
    }
    static func string(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> String? {
        var a = addr(sel, scope); var size = UInt32(MemoryLayout<CFString?>.size); var s: Unmanaged<CFString>?
        guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &s) == noErr, let c = s else { return nil }
        return c.takeRetainedValue() as String
    }
    static func ids(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID] {
        var a = addr(sel, scope); var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(obj, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
        var out = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &out) == noErr else { return [] }
        return out
    }
}

// MARK: - Devices

struct SoundDevice {
    let id: AudioObjectID
    let uid: String
    let name: String
    let transport: String
    let output: Bool
    let input: Bool
}

enum Devices {
    static let system = AudioObjectID(kAudioObjectSystemObject)

    static func all() -> [SoundDevice] {
        HAL.ids(system, kAudioHardwarePropertyDevices).compactMap { id in
            guard let uid = HAL.string(id, kAudioDevicePropertyDeviceUID), let name = HAL.string(id, kAudioObjectPropertyName) else { return nil }
            if name.hasPrefix("Quillmeter") { return nil }                       // our own private tap device
            let out = !HAL.ids(id, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput).isEmpty
            let inp = !HAL.ids(id, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput).isEmpty
            guard out || inp else { return nil }
            let t: UInt32 = HAL.value(id, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain, 0) ?? 0
            if t == kAudioDeviceTransportTypeAggregate || t == kAudioDeviceTransportTypeVirtual && name.contains("Aggregate") { return nil }
            return SoundDevice(id: id, uid: uid, name: name, transport: transportName(t), output: out, input: inp)
        }
    }
    static func transportName(_ t: UInt32) -> String {
        switch t {
        case kAudioDeviceTransportTypeBuiltIn: return "Built-in"
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: return "Bluetooth"
        case kAudioDeviceTransportTypeUSB: return "USB"
        case kAudioDeviceTransportTypeHDMI, kAudioDeviceTransportTypeDisplayPort: return "Display"
        case kAudioDeviceTransportTypeAirPlay: return "AirPlay"
        case kAudioDeviceTransportTypeVirtual: return "Virtual"
        default: return ""
        }
    }
    static func defaultID(output: Bool) -> AudioObjectID {
        HAL.value(system, output ? kAudioHardwarePropertyDefaultOutputDevice : kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain, AudioObjectID(0)) ?? 0
    }
    static func setDefault(output: Bool, id: AudioObjectID) -> Bool {
        HAL.set(system, output ? kAudioHardwarePropertyDefaultOutputDevice : kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain, id)
    }

    // Volume is on the main element when the device has one, otherwise on its channels (1 and 2).
    static func scope(_ output: Bool) -> AudioObjectPropertyScope { output ? kAudioObjectPropertyScopeOutput : kAudioObjectPropertyScopeInput }
    static func volumeElements(_ id: AudioObjectID, output: Bool) -> [AudioObjectPropertyElement] {
        let s = scope(output)
        if HAL.settable(id, kAudioDevicePropertyVolumeScalar, s, kAudioObjectPropertyElementMain) { return [kAudioObjectPropertyElementMain] }
        return [1, 2].filter { HAL.settable(id, kAudioDevicePropertyVolumeScalar, s, $0) }
    }
    static func volume(_ id: AudioObjectID, output: Bool) -> Float? {
        let vals = volumeElements(id, output: output).compactMap { HAL.value(id, kAudioDevicePropertyVolumeScalar, scope(output), $0, Float32(0)) }
        return vals.isEmpty ? nil : vals.reduce(0, +) / Float(vals.count)
    }
    static func setVolume(_ id: AudioObjectID, output: Bool, _ v: Float) -> Bool {
        let els = volumeElements(id, output: output)
        guard !els.isEmpty else { return false }
        let x = Float32(min(max(v, 0), 1))
        return els.map { HAL.set(id, kAudioDevicePropertyVolumeScalar, scope(output), $0, x) }.allSatisfy { $0 }
    }
    static func canMute(_ id: AudioObjectID, output: Bool) -> Bool {
        HAL.settable(id, kAudioDevicePropertyMute, scope(output), kAudioObjectPropertyElementMain)
    }
    static func muted(_ id: AudioObjectID, output: Bool) -> Bool {
        (HAL.value(id, kAudioDevicePropertyMute, scope(output), kAudioObjectPropertyElementMain, UInt32(0)) ?? 0) != 0
    }
    static func setMuted(_ id: AudioObjectID, output: Bool, _ m: Bool) -> Bool {
        HAL.set(id, kAudioDevicePropertyMute, scope(output), kAudioObjectPropertyElementMain, UInt32(m ? 1 : 0))
    }
}

// MARK: - One app's tap

@available(macOS 14.2, *)
final class AppTap {
    let key: String
    let processes: Set<AudioObjectID>
    let outUID: String
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let gain = UnsafeMutablePointer<Float>.allocate(capacity: 1)
    private let queue = DispatchQueue(label: "quillmeter.tap", qos: .userInteractive)
    private(set) var error: String?

    var volume: Float { get { gain.pointee } set { gain.pointee = newValue } }

    init(key: String, processes: Set<AudioObjectID>, outUID: String, volume: Float) {
        self.key = key; self.processes = processes; self.outUID = outUID
        gain.initialize(to: volume)
        start()
    }
    deinit { stop(); gain.deallocate() }

    private func start() {
        let desc = CATapDescription(stereoMixdownOfProcesses: Array(processes))
        desc.uuid = UUID()
        desc.name = "Quillmeter \(key)"
        desc.muteBehavior = .mutedWhenTapped          // the original is silenced; only our copy is heard
        desc.isPrivate = true
        var st = AudioHardwareCreateProcessTap(desc, &tapID)
        guard st == noErr else { error = "Couldn\u{2019}t tap this app (\(st))."; return }
        let dict: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Quillmeter \(key)",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: desc.uuid.uuidString]],
        ]
        st = AudioHardwareCreateAggregateDevice(dict as CFDictionary, &aggID)
        guard st == noErr else { error = "Couldn\u{2019}t set up the audio path (\(st))."; stop(); return }
        let g = gain
        st = AudioDeviceCreateIOProcIDWithBlock(&procID, aggID, queue) { _, inData, _, outData, _ in
            AppTap.process(inData, outData, g.pointee)
        }
        guard st == noErr, procID != nil else { error = "Couldn\u{2019}t start the audio path (\(st))."; stop(); return }
        st = AudioDeviceStart(aggID, procID)
        if st != noErr { error = "Couldn\u{2019}t start the audio path (\(st))."; stop() }
    }

    /// Copy the tapped audio to the output at `g` times its level. Runs on the audio thread: no allocation, no locks.
    static func process(_ inData: UnsafePointer<AudioBufferList>, _ outData: UnsafeMutablePointer<AudioBufferList>, _ g: Float) {
        let ins = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
        let outs = UnsafeMutableAudioBufferListPointer(outData)
        for o in outs { if let p = o.mData { memset(p, 0, Int(o.mDataByteSize)) } }
        let f = MemoryLayout<Float>.size
        if ins.count == outs.count {
            for i in 0..<ins.count {
                guard let ip = ins[i].mData?.assumingMemoryBound(to: Float.self), let op = outs[i].mData?.assumingMemoryBound(to: Float.self) else { continue }
                let ic = Int(max(ins[i].mNumberChannels, 1)), oc = Int(max(outs[i].mNumberChannels, 1))
                let frames = min(Int(ins[i].mDataByteSize) / (f * ic), Int(outs[i].mDataByteSize) / (f * oc))
                for n in 0..<frames { for c in 0..<oc { op[n * oc + c] = ip[n * ic + min(c, ic - 1)] * g } }
            }
        } else if ins.count == 2, outs.count == 1, ins[0].mNumberChannels == 1 {           // two mono buffers into one interleaved
            guard let l = ins[0].mData?.assumingMemoryBound(to: Float.self), let r = ins[1].mData?.assumingMemoryBound(to: Float.self),
                  let op = outs[0].mData?.assumingMemoryBound(to: Float.self) else { return }
            let oc = Int(max(outs[0].mNumberChannels, 1))
            let frames = min(Int(ins[0].mDataByteSize) / f, Int(outs[0].mDataByteSize) / (f * oc))
            for n in 0..<frames { for c in 0..<oc { op[n * oc + c] = (c % 2 == 0 ? l[n] : r[n]) * g } }
        }
    }

    func stop() {
        if let p = procID, aggID != kAudioObjectUnknown { AudioDeviceStop(aggID, p); AudioDeviceDestroyIOProcID(aggID, p); procID = nil }
        if aggID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggID); aggID = AudioObjectID(kAudioObjectUnknown) }
        if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID); tapID = AudioObjectID(kAudioObjectUnknown) }
    }
}

// MARK: - The manager the app talks to

final class SoundManager {
    var onState: ((String) -> Void)?
    var watching = false { didSet { if watching { push() } } }
    private var volumes: [String: Float] = [:]          // per-app volume by app key, 1 = untouched
    private var taps: [String: Any] = [:]               // AppTap, kept as Any so the type needn't be available on older macOS
    private var errors: [String: String] = [:]
    private var timer: Timer?
    static var perAppSupported: Bool { if #available(macOS 14.2, *) { return true } else { return false } }

    init() {
        let t = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
        t.tolerance = 0.3
        timer = t
    }

    private func tick() {
        if !taps.isEmpty { maintainTaps() }
        if watching { push() }
    }

    // MARK: Apps that are making sound

    struct Player { let key: String; let name: String; let pid: pid_t; let processes: [AudioObjectID]; let playing: Bool }

    static func key(forBundle b: String) -> String {
        if let r = b.range(of: ".helper", options: .caseInsensitive) { return String(b[..<r.lowerBound]) }
        return b
    }

    func players() -> [Player] {
        guard Self.perAppSupported else { return [] }
        var groups: [String: (name: String, pid: pid_t, procs: [AudioObjectID], playing: Bool)] = [:]
        for obj in HAL.ids(Devices.system, kAudioHardwarePropertyProcessObjectList) {
            guard let pid: pid_t = HAL.value(obj, kAudioProcessPropertyPID, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain, pid_t(0)), pid != getpid() else { continue }
            let bundle = HAL.string(obj, kAudioProcessPropertyBundleID) ?? NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
            guard !bundle.isEmpty else { continue }
            let key = Self.key(forBundle: bundle)
            let running = (HAL.value(obj, kAudioProcessPropertyIsRunningOutput, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain, UInt32(0)) ?? 0) != 0
            let name = NSRunningApplication.runningApplications(withBundleIdentifier: key).first?.localizedName
                ?? NSRunningApplication(processIdentifier: pid)?.localizedName ?? key.split(separator: ".").last.map(String.init) ?? key
            var g = groups[key] ?? (name, pid, [], false)
            g.procs.append(obj); g.playing = g.playing || running
            groups[key] = g
        }
        return groups.map { Player(key: $0.key, name: $0.value.name, pid: $0.value.pid, processes: $0.value.procs, playing: $0.value.playing) }
            .filter { $0.playing || taps[$0.key] != nil }
            .sorted { ($0.playing ? 0 : 1, $0.name.lowercased()) < ($1.playing ? 0 : 1, $1.name.lowercased()) }
    }

    // MARK: Taps follow the output device and the app's processes

    private func outUID() -> String? { HAL.string(Devices.defaultID(output: true), kAudioDevicePropertyDeviceUID) }

    private func apply(_ key: String, _ v: Float) {
        volumes[key] = v
        guard #available(macOS 14.2, *) else { return }
        if v >= 0.995 { (taps[key] as? AppTap)?.stop(); taps[key] = nil; errors[key] = nil; volumes[key] = nil; return }
        if let t = taps[key] as? AppTap { t.volume = v; return }
        maintainTaps()
    }

    private func maintainTaps() {
        guard #available(macOS 14.2, *), let uid = outUID() else { return }
        let live = Dictionary(uniqueKeysWithValues: players().map { ($0.key, $0) })
        for (key, vol) in volumes {
            guard let p = live[key] else { continue }
            let procs = Set(p.processes)
            if let t = taps[key] as? AppTap, t.error == nil, t.processes == procs, t.outUID == uid { continue }
            (taps[key] as? AppTap)?.stop()
            let t = AppTap(key: key, processes: procs, outUID: uid, volume: vol)
            if let e = t.error { errors[key] = e; taps[key] = nil; volumes[key] = nil } else { errors[key] = nil; taps[key] = t }
        }
        // an app that has quit: drop its tap
        for key in taps.keys where live[key] == nil { (taps[key] as? AppTap)?.stop(); taps[key] = nil; volumes[key] = nil }
    }

    func resetAll() {
        for (_, t) in taps { if #available(macOS 14.2, *) { (t as? AppTap)?.stop() } }
        taps = [:]; volumes = [:]; errors = [:]
    }

    // MARK: Messages from the page

    func handle(_ m: [String: Any]) {
        if let w = m["watch"] as? Bool { watching = w; if !w { return } }
        let all = Devices.all()
        func device(_ d: [String: Any]) -> (SoundDevice, Bool)? {
            guard let uid = d["uid"] as? String, let kind = d["kind"] as? String, kind == "output" || kind == "input",
                  let dev = all.first(where: { $0.uid == uid }) else { return nil }
            let out = kind == "output"
            return (out ? dev.output : dev.input) ? (dev, out) : nil
        }
        if let d = m["setDefault"] as? [String: Any], let (dev, out) = device(d) { _ = Devices.setDefault(output: out, id: dev.id) }
        if let d = m["setVolume"] as? [String: Any], let (dev, out) = device(d), let v = (d["value"] as? NSNumber)?.floatValue { _ = Devices.setVolume(dev.id, output: out, v) }
        if let d = m["setMute"] as? [String: Any], let (dev, out) = device(d), let v = d["value"] as? Bool { _ = Devices.setMuted(dev.id, output: out, v) }
        if let d = m["setAppVolume"] as? [String: Any], let key = d["key"] as? String, let v = (d["value"] as? NSNumber)?.floatValue,
           players().contains(where: { $0.key == key }) { apply(key, min(max(v, 0), 1)) }
        if m["resetApps"] as? Bool == true { resetAll() }
        push()
    }

    // MARK: State for the page

    func stateJSON() -> String {
        let all = Devices.all()
        let defOut = Devices.defaultID(output: true), defIn = Devices.defaultID(output: false)
        func row(_ d: SoundDevice, output: Bool) -> [String: Any] {
            var r: [String: Any] = ["uid": d.uid, "name": d.name, "transport": d.transport, "current": d.id == (output ? defOut : defIn)]
            if let v = Devices.volume(d.id, output: output) { r["volume"] = Double(v) }
            if Devices.canMute(d.id, output: output) { r["muted"] = Devices.muted(d.id, output: output) }
            return r
        }
        let apps: [[String: Any]] = players().map { p in
            var r: [String: Any] = ["key": p.key, "name": p.name, "playing": p.playing, "volume": Double(volumes[p.key] ?? 1)]
            if let e = errors[p.key] { r["error"] = e }
            return r
        }
        let d: [String: Any] = [
            "outputs": all.filter { $0.output }.map { row($0, output: true) },
            "inputs": all.filter { $0.input }.map { row($0, output: false) },
            "apps": apps, "perApp": Self.perAppSupported,
        ]
        return String(data: (try? JSONSerialization.data(withJSONObject: d)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
    }
    func push() { onState?(stateJSON()) }
}
