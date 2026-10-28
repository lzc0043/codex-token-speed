import AppKit
import Darwin

func windowRect(_ window: [String: Any]) -> CGRect? {
    guard let b = window[kCGWindowBounds as String] as? [String: CGFloat],
          let x = b["X"], let y = b["Y"], let w = b["Width"], let h = b["Height"] else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

func targetWindowIndex(_ windows: [[String: Any]], pids: Set<Int32>) -> Int? {
    windows.firstIndex(where: {
        pids.contains($0[kCGWindowOwnerPID as String] as? Int32 ?? -1) &&
        ($0[kCGWindowLayer as String] as? Int) == 0 &&
        ($0[kCGWindowAlpha as String] as? Double ?? 1) > 0 &&
        (windowRect($0)?.width ?? 0) >= 500 && (windowRect($0)?.height ?? 0) >= 200
    })
}

func meterFrame(_ bounds: CGRect) -> CGRect? {
    // shortcut: reserve control space geometrically until Codex exposes a composer slot.
    let contentWidth = min(800, bounds.width - 48)
    let left = bounds.midX - contentWidth / 2 + 150
    let right = bounds.midX + contentWidth / 2 - 320
    guard right - left >= 228 else { return nil }
    return CGRect(x: (left + right - 228) / 2, y: bounds.maxY - 52, width: 228, height: 25)
}

func statusIsCovered(_ windows: [[String: Any]], before index: Int, frame: CGRect, ownPID: Int32) -> Bool {
    let targetPID = windows[index][kCGWindowOwnerPID as String] as? Int32
    return windows.prefix(index).contains { window in
        guard (window[kCGWindowOwnerPID as String] as? Int32) != ownPID,
              (window[kCGWindowOwnerPID as String] as? Int32) != targetPID,
              (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              (0...Int(NSWindow.Level.floating.rawValue)).contains(window[kCGWindowLayer as String] as? Int ?? 0),
              let bounds = windowRect(window) else { return false }
        return bounds.intersects(frame)
    }
}

#if VISIBILITY_TEST
func fixture(_ pid: Int32, _ rect: CGRect, alpha: Double = 1) -> [String: Any] {
    [kCGWindowOwnerPID as String: pid, kCGWindowAlpha as String: alpha, kCGWindowLayer as String: 0,
     kCGWindowBounds as String: ["X": rect.minX, "Y": rect.minY, "Width": rect.width, "Height": rect.height]]
}
let strip = CGRect(x: 400, y: 700, width: 330, height: 25)
let codex = fixture(1, CGRect(x: 0, y: 0, width: 1200, height: 800))
assert(!statusIsCovered([fixture(2, CGRect(x: 0, y: 0, width: 300, height: 300)), codex], before: 1, frame: strip, ownPID: 3))
assert(statusIsCovered([fixture(2, strip), codex], before: 1, frame: strip, ownPID: 3))
assert(!statusIsCovered([fixture(3, strip), codex], before: 1, frame: strip, ownPID: 3))
assert(!statusIsCovered([fixture(2, strip, alpha: 0), codex], before: 1, frame: strip, ownPID: 3))
assert(!statusIsCovered([codex, fixture(2, strip)], before: 0, frame: strip, ownPID: 3))
var capture = fixture(2, strip); capture[kCGWindowLayer as String] = 1000
assert(!statusIsCovered([capture, codex], before: 1, frame: strip, ownPID: 3))
let fullscreen = [fixture(1, CGRect(x: 0, y: 33, width: 1512, height: 32), alpha: 0),
                  fixture(1, CGRect(x: 0, y: 33, width: 1512, height: 949))]
assert(targetWindowIndex(fullscreen, pids: [1]) == 1, "Full screen must follow the content window, not its 32pt auxiliary window")
assert(meterFrame(CGRect(x: 0, y: 0, width: 650, height: 800)) == nil, "A narrow operation row must hide metrics instead of overlapping controls")
for width in [746.0, 800, 1100, 1512, 2400] {
    let b = CGRect(x: -300, y: -100, width: width, height: 900)
    let f = meterFrame(b)!, contentWidth = min(800, b.width - 48)
    assert(f.minX >= b.midX - contentWidth / 2 + 150 && f.maxX <= b.midX + contentWidth / 2 - 320)
    assert(f.maxY == b.maxY - 27)
}
assert(!statusIsCovered([fixture(1, strip), codex], before: 1, frame: strip, ownPID: 3))
print("Window visibility checks passed")
exit(0)
#else

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 228, height: 25),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = false
panel.ignoresMouseEvents = true
panel.hidesOnDeactivate = false
panel.level = .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .canJoinAllApplications]
let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
let mutedColor = NSColor(calibratedWhite: 0.55, alpha: 1)
let numberColor = NSColor(calibratedWhite: 0.4, alpha: 1)
func field(_ text: String, x: CGFloat, width: CGFloat, numeric: Bool = false) -> NSTextField {
    let view = NSTextField(labelWithString: text)
    view.frame = NSRect(x: x, y: 4, width: width, height: 18)
    view.font = numeric ? numberFont : .systemFont(ofSize: 11)
    view.alignment = numeric ? .right : .left
    view.textColor = numeric ? numberColor : mutedColor
    view.drawsBackground = false
    panel.contentView?.addSubview(view)
    return view
}
let speedField = field("", x: 22, width: 42, numeric: true)
let unitField = field("t/s", x: 66, width: 18)
let separator = field("·", x: 88, width: 8)
let cacheName = field("会话缓存", x: 118, width: 48)
let cacheField = field("", x: 170, width: 50, numeric: true)
let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
func icon(_ name: String, x: CGFloat) -> NSImageView {
    guard let image = NSImage(contentsOf: root.appendingPathComponent("assets/icons/\(name).png")) else {
        fputs("Missing meter icon: \(name)\n", stderr); exit(1)
    }
    image.isTemplate = true
    let view = NSImageView(frame: NSRect(x: x, y: 6, width: 14, height: 14))
    view.image = image; view.contentTintColor = mutedColor
    view.imageScaling = .scaleProportionallyUpOrDown
    view.setAccessibilityElement(false)
    panel.contentView?.addSubview(view)
    return view
}
let gaugeIcon = icon("gauge", x: 4)
let cacheIcon = icon("database", x: 100)
let baseline = unitField.frame.maxY - unitField.firstBaselineOffsetFromTop
for view in [speedField, cacheField] {
    view.frame.origin.y += baseline - (view.frame.maxY - view.firstBaselineOffsetFromTop)
}
panel.setAccessibilityLabel("Codex Token 速度计，近似输出速度与会话缓存命中率")

let previewIndex = CommandLine.arguments.firstIndex(of: "--preview")
let previewPath = previewIndex.flatMap { $0 + 1 < CommandLine.arguments.count ? CommandLine.arguments[$0 + 1] : nil }
if CommandLine.arguments.contains("--dark-preview") { panel.appearance = NSAppearance(named: .darkAqua) }
var lastAppearance: NSAppearance.Name?
func updateColors() {
    let appearance = panel.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua])
    guard appearance != lastAppearance else { return }
    lastAppearance = appearance
    let color = NSColor(calibratedWhite: appearance == .darkAqua ? 0.8 : 0.4, alpha: 1)
    speedField.textColor = color; cacheField.textColor = color
}
func savePreview() {
    guard let path = previewPath, let view = panel.contentView,
          let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    let image = NSImage(size: view.bounds.size)
    image.lockFocus()
    let dark = CommandLine.arguments.contains("--dark-preview")
    NSColor(calibratedWhite: dark ? 0.12 : 1, alpha: 1).setFill(); view.bounds.fill()
    NSImage(cgImage: bitmap.cgImage!, size: view.bounds.size).draw(in: view.bounds)
    image.unlockFocus()
    guard let data = image.tiffRepresentation,
          let png = NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]) else { return }
    do { try png.write(to: URL(fileURLWithPath: path)) }
    catch { fputs("Cannot save meter preview\n", stderr) }
}

func applyReading(_ text: String) -> String {
    let parts = text.components(separatedBy: "   ·   ")
    var speed = "", cache = ""
    if parts.count == 2 && parts[0].hasSuffix(" t/s") && parts[1].hasPrefix("会话缓存 ") {
        speed = String(parts[0].dropLast(4)); cache = String(parts[1].dropFirst(5))
        let validSpeed = speed == "--" || (Double(speed).map { $0.isFinite && $0 >= 0 } ?? false)
        let percent = cache.hasSuffix("%") ? Double(String(cache.dropLast())) : nil
        let validCache = cache == "--" || (percent.map { $0.isFinite && (0...100).contains($0) } ?? false)
        if !validSpeed || !validCache { speed = ""; cache = "" }
    }
    speedField.stringValue = speed; cacheField.stringValue = cache
    let result = speed.isEmpty || cache.isEmpty ? "" : "\(speedField.stringValue) t/s   ·   会话缓存 \(cacheField.stringValue)"
    if !result.isEmpty { savePreview() }
    let widths = (0...9).map { (String($0) as NSString).size(withAttributes: [.font: numberFont]).width }
    let layout: [String: Any] = ["speedX": speedField.frame.minX, "speedWidth": speedField.frame.width,
        "cacheGroupX": cacheIcon.frame.minX, "cacheX": cacheField.frame.minX, "cacheWidth": cacheField.frame.width,
        "digitWidths": widths, "iconCount": panel.contentView!.subviews.filter { $0 is NSImageView }.count, "fontSize": numberFont.pointSize,
        "speedBaseline": speedField.frame.maxY - speedField.firstBaselineOffsetFromTop,
        "unitBaseline": unitField.frame.maxY - unitField.firstBaselineOffsetFromTop, "bottomInset": 27,
        "fullScreenSupport": panel.collectionBehavior.contains(.canJoinAllApplications)]
    if let json = try? JSONSerialization.data(withJSONObject: layout), let value = String(data: json, encoding: .utf8) {
        print("display-layout\t" + value)
    }
    return result
}

let home = ProcessInfo.processInfo.environment["CODEX_HOME"] ?? NSHomeDirectory() + "/.codex"
let directory = home + "/token-speed"
do { try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
catch { fputs("Cannot create display lock directory\n", stderr); exit(1) }
let fd = open(directory + "/display.lock", O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
if fd < 0 { fputs("Cannot open display lock\n", stderr); exit(1) }
var ownsDisplay = false
let inputLock = NSLock()
var receivedText = ""
var inputEnded = false
let headless = CommandLine.arguments.contains("--headless") || previewPath != nil
var lastInput: String?
var renderedText = ""
var reportedVisible: Bool?
func reportVisibility(_ visible: Bool) {
    guard ownsDisplay, reportedVisible != visible else { return }
    reportedVisible = visible
    print(visible ? "display-visible" : "display-hidden"); fflush(stdout)
}

DispatchQueue.global().async {
    while let line = readLine() {
        if line.utf8.count <= 512 {
            inputLock.lock(); receivedText = line; inputLock.unlock()
        }
    }
    inputLock.lock(); inputEnded = true; inputLock.unlock()
}

// CGWindow geometry is public and does not require reading the screen's pixels.
let timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    inputLock.lock(); let text = receivedText; let ended = inputEnded; inputLock.unlock()
    if ended { app.terminate(nil); return }
    if !ownsDisplay {
        ownsDisplay = flock(fd, LOCK_EX | LOCK_NB) == 0
        if ownsDisplay { print("display-owner"); fflush(stdout) }
    }
    updateColors()
    if ownsDisplay && lastInput != text {
        lastInput = text; renderedText = applyReading(text)
        print("display-text\t" + renderedText); fflush(stdout)
    }
    let codexPIDs = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex").map { $0.processIdentifier })
    guard ownsDisplay, !headless, !renderedText.isEmpty,
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let index = targetWindowIndex(windows, pids: codexPIDs),
          let bounds = windowRect(windows[index]),
          let screen = NSScreen.screens.first
    else { panel.orderOut(nil); reportVisibility(false); return }
    guard let strip = meterFrame(bounds) else { panel.orderOut(nil); reportVisibility(false); return }
    guard !statusIsCovered(windows, before: index, frame: strip, ownPID: getpid()) else {
        panel.orderOut(nil); reportVisibility(false); return
    }
    // shortcut: bottom-centre attachment, use a public composer slot if Codex adds one.
    let origin = NSPoint(x: strip.minX, y: screen.frame.maxY - strip.maxY)
    panel.setFrameOrigin(origin)
    panel.orderFrontRegardless()
    reportVisibility(panel.isVisible)
}
RunLoop.main.add(timer, forMode: .common)
app.run()
close(fd)
#endif
