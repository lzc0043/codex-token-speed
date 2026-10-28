import AppKit
import Darwin

func windowRect(_ window: [String: Any]) -> CGRect? {
    guard let b = window[kCGWindowBounds as String] as? [String: CGFloat],
          let x = b["X"], let y = b["Y"], let w = b["Width"], let h = b["Height"] else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}

func statusIsCovered(_ windows: [[String: Any]], before index: Int, frame: CGRect, ownPID: Int32) -> Bool {
    windows.prefix(index).contains { window in
        guard (window[kCGWindowOwnerPID as String] as? Int32) != ownPID,
              (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              (0...Int(NSWindow.Level.floating.rawValue)).contains(window[kCGWindowLayer as String] as? Int ?? 0),
              let bounds = windowRect(window) else { return false }
        return bounds.intersects(frame)
    }
}

#if VISIBILITY_TEST
func fixture(_ pid: Int32, _ rect: CGRect, alpha: Double = 1) -> [String: Any] {
    [kCGWindowOwnerPID as String: pid, kCGWindowAlpha as String: alpha,
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
print("Window visibility checks passed")
exit(0)
#else

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 330, height: 25),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.isOpaque = false
panel.backgroundColor = .clear
panel.hasShadow = false
panel.ignoresMouseEvents = true
panel.hidesOnDeactivate = false
panel.level = .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
let label = NSTextField(labelWithString: "")
label.frame = NSRect(x: 8, y: 4, width: 314, height: 18)
label.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
label.drawsBackground = false
label.alignment = .center
label.textColor = .secondaryLabelColor
panel.contentView?.addSubview(label)
panel.setAccessibilityLabel("Codex Token 速度计，近似输出速度与会话缓存命中率")

let home = ProcessInfo.processInfo.environment["CODEX_HOME"] ?? NSHomeDirectory() + "/.codex"
let directory = home + "/token-speed"
do { try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
catch { fputs("Cannot create display lock directory\n", stderr); exit(1) }
let fd = open(directory + "/display.lock", O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
if fd < 0 { fputs("Cannot open display lock\n", stderr); exit(1) }
var ownsDisplay = false
var reportedVisible: Bool?
func reportVisibility(_ visible: Bool) {
    guard ownsDisplay, reportedVisible != visible else { return }
    reportedVisible = visible
    print(visible ? "display-visible" : "display-hidden"); fflush(stdout)
}

DispatchQueue.global().async {
    while let line = readLine() {
        if line.utf8.count <= 512 {
            DispatchQueue.main.async { label.stringValue = line }
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}

// CGWindow geometry is public and does not require reading the screen's pixels.
let timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
    if !ownsDisplay {
        ownsDisplay = flock(fd, LOCK_EX | LOCK_NB) == 0
        if ownsDisplay { print("display-owner"); fflush(stdout) }
    }
    let codexPIDs = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.openai.codex").map { $0.processIdentifier })
    guard ownsDisplay, !label.stringValue.isEmpty,
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let index = windows.firstIndex(where: {
              codexPIDs.contains($0[kCGWindowOwnerPID as String] as? Int32 ?? -1) &&
              ($0[kCGWindowLayer as String] as? Int) == 0 &&
              (windowRect($0)?.width ?? 0) >= 500
          }),
          let bounds = windowRect(windows[index]),
          let screen = NSScreen.screens.first
    else { panel.orderOut(nil); reportVisibility(false); return }
    let strip = CGRect(x: bounds.midX - 165, y: bounds.maxY - 30, width: 330, height: 25)
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
