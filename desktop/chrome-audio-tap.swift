import CoreAudio
import Darwin
import Dispatch
import Foundation

struct TapConfig {
    var checkOnly = false
    var listOnly = false
    var sampleRate: Int = 16000
    var blockSize: Int = 512
    var muteWhenTapped: Bool = true
    var bundlePrefixes: [String] = ["com.google.chrome", "org.chromium.chromium"]
    // When set, only Chrome processes launched with this --user-data-dir (or
    // their helpers) are tapped and muted. Other Chrome windows, such as a
    // Messenger call, stay audible.
    var profileDir: String? = nil
}

func parseArgs() -> TapConfig {
    var cfg = TapConfig()
    var customPrefixes: [String] = []
    let args = Array(CommandLine.arguments.dropFirst())
    var i = 0
    while i < args.count {
        let arg = args[i]
        switch arg {
        case "--check":
            cfg.checkOnly = true
        case "--list-processes":
            cfg.listOnly = true
        case "--mute":
            cfg.muteWhenTapped = true
        case "--no-mute":
            cfg.muteWhenTapped = false
        case "--sample-rate":
            if i + 1 < args.count, let v = Int(args[i + 1]), v >= 4000, v <= 96000 {
                cfg.sampleRate = v
                i += 1
            }
        case "--block-size":
            if i + 1 < args.count, let v = Int(args[i + 1]), v >= 64, v <= 8192 {
                cfg.blockSize = v
                i += 1
            }
        case "--profile-dir":
            if i + 1 < args.count {
                cfg.profileDir = args[i + 1]
                i += 1
            }
        case "--bundle-prefix":
            if i + 1 < args.count {
                customPrefixes.append(args[i + 1].lowercased())
                i += 1
            }
        default:
            break
        }
        i += 1
    }
    if !customPrefixes.isEmpty {
        cfg.bundlePrefixes = customPrefixes
    }
    return cfg
}

struct ProcessAudioEntry: Codable {
    let object_id: UInt32
    let pid: Int32
    let bundle_id: String
    let running_output: Bool
}

func enumerateAudioProcesses() -> [ProcessAudioEntry] {
    var addr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr,
          size > 0 else {
        return []
    }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var objectIDs = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &objectIDs) == noErr else {
        return []
    }

    var result: [ProcessAudioEntry] = []
    for obj in objectIDs {
        var pidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyPID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pid: pid_t = 0
        var pidSize = UInt32(MemoryLayout<pid_t>.size)
        AudioObjectGetPropertyData(obj, &pidAddr, 0, nil, &pidSize, &pid)

        var bidAddr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyBundleID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var bidRef: Unmanaged<CFString>? = nil
        var bidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let bst = AudioObjectGetPropertyData(obj, &bidAddr, 0, nil, &bidSize, &bidRef)
        let bundleID = (bst == noErr ? bidRef?.takeRetainedValue() as String? : nil) ?? ""

        var outAddr = AudioObjectPropertyAddress(
            mSelector: kAudioProcessPropertyIsRunningOutput,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var runningOut: UInt32 = 0
        var outSize = UInt32(MemoryLayout<UInt32>.size)
        AudioObjectGetPropertyData(obj, &outAddr, 0, nil, &outSize, &runningOut)

        result.append(ProcessAudioEntry(
            object_id: obj,
            pid: pid,
            bundle_id: bundleID,
            running_output: runningOut != 0
        ))
    }
    return result
}

func parentPID(of pid: pid_t) -> pid_t? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
    return info.kp_eproc.e_ppid
}

func processArguments(of pid: pid_t) -> [String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return [] }
    var buffer = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return [] }
    let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
    var index = MemoryLayout<Int32>.size
    // Skip the executable path and its NUL padding.
    while index < size && buffer[index] != 0 { index += 1 }
    while index < size && buffer[index] == 0 { index += 1 }
    var args: [String] = []
    var start = index
    while index < size && args.count < Int(argc) {
        if buffer[index] == 0 {
            args.append(String(decoding: buffer[start..<index], as: UTF8.self))
            start = index + 1
        }
        index += 1
    }
    return args
}

/// True when `pid` or an ancestor was started with `--user-data-dir=<dir>`.
func belongsToProfile(_ pid: pid_t, profileDir: String) -> Bool {
    let wanted = (profileDir as NSString).standardizingPath
    var current: pid_t? = pid
    var hops = 0
    while let candidate = current, candidate > 1, hops < 8 {
        for arg in processArguments(of: candidate) where arg.hasPrefix("--user-data-dir=") {
            let value = String(arg.dropFirst("--user-data-dir=".count))
            if (value as NSString).standardizingPath == wanted { return true }
        }
        current = parentPID(of: candidate)
        hops += 1
    }
    return false
}

func matchingProcessIDs(prefixes: [String], profileDir: String? = nil) -> [AudioObjectID] {
    let selfPID = getpid()
    let parentPID = getppid()
    return enumerateAudioProcesses().compactMap { entry in
        if entry.pid == selfPID || entry.pid == parentPID {
            return nil
        }
        let lowered = entry.bundle_id.lowercased()
        guard !lowered.isEmpty else { return nil }
        guard prefixes.contains(where: { lowered.hasPrefix($0) }) else { return nil }
        if let dir = profileDir, !belongsToProfile(entry.pid, profileDir: dir) {
            return nil
        }
        return AudioObjectID(entry.object_id)
    }
}

final class RealTimeRingBuffer {
    private var storage: [Float]
    private let capacity: Int
    private var writeIndex: Int = 0
    private var readIndex: Int = 0
    private var available: Int = 0
    private var lock = os_unfair_lock()
    private var lastPushHostTime: UInt64 = 0

    init(capacity: Int) {
        self.capacity = max(4096, capacity)
        self.storage = [Float](repeating: 0, count: self.capacity)
    }

    func pushMono(_ ptr: UnsafePointer<Float>, count: Int) {
        guard count > 0 else { return }
        os_unfair_lock_lock(&lock)
        lastPushHostTime = mach_absolute_time()
        var srcOffset = 0
        var n = count
        if n > capacity {
            srcOffset = n - capacity
            n = capacity
        }
        // Drop oldest samples on overflow so latency stays bounded.
        let overflow = (available + n) - capacity
        if overflow > 0 {
            readIndex = (readIndex + overflow) % capacity
            available -= overflow
        }
        let firstChunk = min(n, capacity - writeIndex)
        storage.withUnsafeMutableBufferPointer { dst in
            guard let base = dst.baseAddress else { return }
            base.advanced(by: writeIndex).update(from: ptr.advanced(by: srcOffset), count: firstChunk)
            let secondChunk = n - firstChunk
            if secondChunk > 0 {
                base.update(from: ptr.advanced(by: srcOffset + firstChunk), count: secondChunk)
            }
        }
        writeIndex = (writeIndex + n) % capacity
        available += n
        os_unfair_lock_unlock(&lock)
    }

    func drain(into out: inout [Float]) -> (count: Int, lastPush: UInt64) {
        os_unfair_lock_lock(&lock)
        let n = available
        let pushTime = lastPushHostTime
        if n == 0 {
            os_unfair_lock_unlock(&lock)
            return (0, pushTime)
        }
        if out.count < n {
            out = [Float](repeating: 0, count: max(n, out.count * 2))
        }
        let firstChunk = min(n, capacity - readIndex)
        storage.withUnsafeBufferPointer { src in
            out.withUnsafeMutableBufferPointer { dst in
                guard let sBase = src.baseAddress, let dBase = dst.baseAddress else { return }
                dBase.update(from: sBase.advanced(by: readIndex), count: firstChunk)
                let secondChunk = n - firstChunk
                if secondChunk > 0 {
                    dBase.advanced(by: firstChunk).update(from: sBase, count: secondChunk)
                }
            }
        }
        readIndex = (readIndex + n) % capacity
        available = 0
        os_unfair_lock_unlock(&lock)
        return (n, pushTime)
    }
}

final class StreamingResampler {
    private let sourceRate: Double
    private let targetRate: Double
    private let step: Double
    private var history: [Float] = []
    private var phase: Double = 0.0

    init(sourceRate: Double, targetRate: Double) {
        self.sourceRate = max(1000.0, sourceRate)
        self.targetRate = max(1000.0, targetRate)
        self.step = self.sourceRate / self.targetRate
    }

    func process(_ input: UnsafeBufferPointer<Float>, into output: inout [Float]) {
        guard !input.isEmpty else { return }
        if abs(sourceRate - targetRate) < 0.5 {
            output.append(contentsOf: input)
            return
        }
        history.append(contentsOf: input)
        let count = history.count
        guard count >= 2 else { return }

        // Anti-aliased boxcar + linear interpolation across fractional step.
        let radius = max(1, Int(step.rounded(.down)))
        while Int(phase) + 1 < count {
            let idx = Int(phase)
            if radius >= 2 && idx + radius <= count {
                var sum: Float = 0
                for k in 0..<radius {
                    sum += history[idx + k]
                }
                output.append(sum / Float(radius))
            } else {
                let frac = Float(phase - Double(idx))
                let s0 = history[idx]
                let s1 = history[idx + 1]
                output.append(s0 + (s1 - s0) * frac)
            }
            phase += step
        }
        let consumed = min(count - 1, Int(phase))
        if consumed > 0 {
            history.removeFirst(consumed)
            phase -= Double(consumed)
        }
    }
}

func writeAllStdout(_ samples: UnsafeBufferPointer<Float>) -> Bool {
    guard !samples.isEmpty else { return true }
    let rawBytes = UnsafeRawBufferPointer(samples)
    guard let base = rawBytes.baseAddress else { return true }
    var offset = 0
    let total = rawBytes.count
    while offset < total {
        let written = Darwin.write(STDOUT_FILENO, base.advanced(by: offset), total - offset)
        if written < 0 {
            if errno == EINTR { continue }
            return false
        }
        if written == 0 { return false }
        offset += written
    }
    return true
}

func hostTimeSeconds(_ delta: UInt64) -> Double {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    let nanos = Double(delta) * Double(info.numer) / Double(max(1, info.denom))
    return nanos / 1_000_000_000.0
}

func logStderr(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write(Data((line + "\n").utf8))
    }
}

let config = parseArgs()
signal(SIGPIPE, SIG_IGN)

if config.checkOnly {
    if #available(macOS 14.2, *) {
        print("{\"ok\":true,\"supported\":true}")
        exit(0)
    } else {
        print("{\"ok\":false,\"supported\":false}")
        exit(1)
    }
}

if config.listOnly {
    let all = enumerateAudioProcesses()
    let matched = Set(matchingProcessIDs(prefixes: config.bundlePrefixes, profileDir: config.profileDir))
    let matchedEntries = all.filter { matched.contains($0.object_id) }
    let payload: [String: Any] = [
        "ok": true,
        "matched_count": matchedEntries.count,
        "matched": matchedEntries.map { [
            "object_id": $0.object_id,
            "pid": $0.pid,
            "bundle_id": $0.bundle_id,
            "running_output": $0.running_output,
        ] },
    ]
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
    exit(0)
}

guard #available(macOS 14.2, *) else {
    logStderr(["event": "tap_error", "error": "macOS 14.2 or newer is required for Chrome Audio Tap."])
    exit(2)
}

var currentProcessIDs = matchingProcessIDs(prefixes: config.bundlePrefixes, profileDir: config.profileDir)
let tapDesc = CATapDescription(monoMixdownOfProcesses: currentProcessIDs)
tapDesc.uuid = UUID()
tapDesc.name = "Roku Sync Chrome Reference Tap"
tapDesc.isPrivate = true
tapDesc.muteBehavior = config.muteWhenTapped ? .mutedWhenTapped : .unmuted
if #available(macOS 26.0, *), config.profileDir == nil {
    // Bundle IDs tap every Chrome window, so they are only used without a
    // dedicated reference profile.
    tapDesc.bundleIDs = [
        "com.google.Chrome",
        "com.google.Chrome.helper",
        "com.google.Chrome.canary",
        "com.google.Chrome.canary.helper",
        "com.google.Chrome.beta",
        "com.google.Chrome.beta.helper",
        "org.chromium.Chromium",
        "org.chromium.Chromium.helper",
    ]
    tapDesc.isProcessRestoreEnabled = true
}

var tapID = AudioObjectID(kAudioObjectUnknown)
let stTap = AudioHardwareCreateProcessTap(tapDesc, &tapID)
if stTap != noErr || tapID == kAudioObjectUnknown {
    logStderr([
        "event": "tap_error",
        "status": stTap,
        "error": "macOS System Audio Recording permission is required to tap Chrome silently. Enable Roku Sync in System Settings > Privacy & Security > Screen & System Audio Recording (System Audio Recording Only).",
    ])
    exit(2)
}

var fmtAddr = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
var asbd = AudioStreamBasicDescription()
var fmtSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
let stFmt = AudioObjectGetPropertyData(tapID, &fmtAddr, 0, nil, &fmtSize, &asbd)
let nativeRate = (stFmt == noErr && asbd.mSampleRate > 0) ? asbd.mSampleRate : 48000.0
let channels = max(1, Int(asbd.mChannelsPerFrame))
let isFloat = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
let bitsPerChannel = Int(asbd.mBitsPerChannel)

let aggUID = "dev.rokusync.chrometap.\(UUID().uuidString)"
let aggDesc: [String: Any] = [
    kAudioAggregateDeviceNameKey: "Roku Sync Chrome Reference",
    kAudioAggregateDeviceUIDKey: aggUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceTapListKey: [
        [
            kAudioSubTapUIDKey: tapDesc.uuid.uuidString,
            kAudioSubTapDriftCompensationKey: true,
        ]
    ],
]

var aggID = AudioObjectID(kAudioObjectUnknown)
let stAgg = AudioHardwareCreateAggregateDevice(aggDesc as CFDictionary, &aggID)
if stAgg != noErr || aggID == kAudioObjectUnknown {
    AudioHardwareDestroyProcessTap(tapID)
    logStderr(["event": "tap_error", "status": stAgg, "error": "Could not create private CoreAudio tap aggregate device."])
    exit(2)
}

let ring = RealTimeRingBuffer(capacity: Int(nativeRate) * 2)
var scratchMono = [Float](repeating: 0, count: 8192)
var ioProcID: AudioDeviceIOProcID? = nil

let stIO = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggID, nil) { _, inInputData, _, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
    guard let first = buffers.first, let rawData = first.mData, first.mDataByteSize > 0 else { return }

    if isFloat && bitsPerChannel == 32 {
        if isNonInterleaved || channels == 1 {
            let frameCount = min(scratchMono.count, Int(first.mDataByteSize) / MemoryLayout<Float>.size)
            guard frameCount > 0 else { return }
            if buffers.count == 1 {
                let ptr = rawData.assumingMemoryBound(to: Float.self)
                ring.pushMono(ptr, count: frameCount)
            } else {
                let scale = 1.0 / Float(buffers.count)
                scratchMono.withUnsafeMutableBufferPointer { dst in
                    guard let out = dst.baseAddress else { return }
                    for i in 0..<frameCount { out[i] = 0 }
                    for buf in buffers {
                        guard let bData = buf.mData else { continue }
                        let bPtr = bData.assumingMemoryBound(to: Float.self)
                        let n = min(frameCount, Int(buf.mDataByteSize) / MemoryLayout<Float>.size)
                        for i in 0..<n { out[i] += bPtr[i] * scale }
                    }
                    ring.pushMono(out, count: frameCount)
                }
            }
        } else {
            let totalFloats = Int(first.mDataByteSize) / MemoryLayout<Float>.size
            let frameCount = min(scratchMono.count, totalFloats / channels)
            guard frameCount > 0 else { return }
            let ptr = rawData.assumingMemoryBound(to: Float.self)
            let scale = 1.0 / Float(channels)
            scratchMono.withUnsafeMutableBufferPointer { dst in
                guard let out = dst.baseAddress else { return }
                for f in 0..<frameCount {
                    var sum: Float = 0
                    let base = f * channels
                    for c in 0..<channels { sum += ptr[base + c] }
                    out[f] = sum * scale
                }
                ring.pushMono(out, count: frameCount)
            }
        }
    } else if bitsPerChannel == 16 {
        let totalSamples = Int(first.mDataByteSize) / MemoryLayout<Int16>.size
        let stepCh = isNonInterleaved ? 1 : channels
        let frameCount = min(scratchMono.count, totalSamples / max(1, stepCh))
        guard frameCount > 0 else { return }
        let ptr = rawData.assumingMemoryBound(to: Int16.self)
        let scale = 1.0 / (32768.0 * Float(stepCh))
        scratchMono.withUnsafeMutableBufferPointer { dst in
            guard let out = dst.baseAddress else { return }
            for f in 0..<frameCount {
                var sum: Float = 0
                let base = f * stepCh
                for c in 0..<stepCh { sum += Float(ptr[base + c]) }
                out[f] = sum * scale
            }
            ring.pushMono(out, count: frameCount)
        }
    }
}

let stStart = AudioDeviceStart(aggID, ioProcID)
if stStart != noErr {
    if let ioProcID { AudioDeviceDestroyIOProcID(aggID, ioProcID) }
    AudioHardwareDestroyAggregateDevice(aggID)
    AudioHardwareDestroyProcessTap(tapID)
    logStderr(["event": "tap_error", "status": stStart, "error": "CoreAudio tap failed to start capture. Check System Audio Recording permission."])
    exit(2)
}

// Keep the process list current when Chrome launches new audio utility helpers.
let listenerQueue = DispatchQueue(label: "dev.rokusync.chrometap.procs")
var procListAddr = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
let procListener: AudioObjectPropertyListenerBlock = { _, _ in
    let latest = matchingProcessIDs(prefixes: config.bundlePrefixes, profileDir: config.profileDir)
    if Set(latest) != Set(currentProcessIDs) {
        currentProcessIDs = latest
        tapDesc.processes = latest
        var descAddr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyDescription,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var unmanagedDesc = Unmanaged.passUnretained(tapDesc)
        AudioObjectSetPropertyData(
            tapID,
            &descAddr,
            0,
            nil,
            UInt32(MemoryLayout<Unmanaged<CATapDescription>>.size),
            &unmanagedDesc
        )
    }
}
AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &procListAddr, listenerQueue, procListener)

var stopping = false
let stopLock = NSLock()
func requestStop() {
    stopLock.lock()
    stopping = true
    stopLock.unlock()
}
func isStopping() -> Bool {
    stopLock.lock()
    defer { stopLock.unlock() }
    return stopping
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)
let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: listenerQueue)
sigIntSource.setEventHandler { requestStop() }
sigIntSource.resume()
let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: listenerQueue)
sigTermSource.setEventHandler { requestStop() }
sigTermSource.resume()

let resampler = StreamingResampler(sourceRate: nativeRate, targetRate: Double(config.sampleRate))
var drainBuf = [Float](repeating: 0, count: Int(nativeRate))
var outPending: [Float] = []
outPending.reserveCapacity(config.blockSize * 4)
let silenceBlock = [Float](repeating: 0, count: config.blockSize)
var lastOutputTime = mach_absolute_time()
let blockDurationS = Double(config.blockSize) / Double(config.sampleRate)

while !isStopping() {
    let (drained, lastPush) = ring.drain(into: &drainBuf)
    if drained > 0 {
        drainBuf.withUnsafeBufferPointer { full in
            let slice = UnsafeBufferPointer(rebasing: full[0..<drained])
            resampler.process(slice, into: &outPending)
        }
    }

    var wroteAny = false
    while outPending.count >= config.blockSize {
        let ok = outPending.withUnsafeBufferPointer { full in
            let chunk = UnsafeBufferPointer(rebasing: full[0..<config.blockSize])
            return writeAllStdout(chunk)
        }
        if !ok {
            requestStop()
            break
        }
        outPending.removeFirst(config.blockSize)
        lastOutputTime = mach_absolute_time()
        wroteAny = true
    }

    if isStopping() { break }

    if !wroteAny {
        let now = mach_absolute_time()
        let idleCallbackS = lastPush == 0 ? 1.0 : hostTimeSeconds(now - lastPush)
        let sinceOutS = hostTimeSeconds(now - lastOutputTime)
        if idleCallbackS > 0.06 && sinceOutS >= blockDurationS {
            let ok = silenceBlock.withUnsafeBufferPointer { writeAllStdout($0) }
            if !ok {
                requestStop()
                break
            }
            lastOutputTime = now
        } else {
            usleep(6000)
        }
    }
}

AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &procListAddr, listenerQueue, procListener)
if let ioProcID {
    AudioDeviceStop(aggID, ioProcID)
    AudioDeviceDestroyIOProcID(aggID, ioProcID)
}
AudioHardwareDestroyAggregateDevice(aggID)
AudioHardwareDestroyProcessTap(tapID)
exit(0)
