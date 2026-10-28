import AppKit
import Darwin

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 330, height: 25),
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
panel.isOpaque = false
panel.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.94)
panel.hasShadow = false
panel.ignoresMouseEvents = true
panel.hidesOnDeactivate = false
panel.level = .floating
panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
panel.contentView?.wantsLayer = true
panel.contentView?.layer?.cornerRadius = 10
let label = NSTextField(labelWithString: "≈ -- t/s   ·   缓存命中 --")
label.frame = NSRect(x: 8, y: 4, width: 314, height: 18)
label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
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
    guard ownsDisplay,
          let front = NSWorkspace.shared.frontmostApplication,
          front.bundleIdentifier == "com.openai.codex",
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          let window = windows.first(where: {
              ($0[kCGWindowOwnerPID as String] as? Int32) == front.processIdentifier &&
              ($0[kCGWindowLayer as String] as? Int) == 0 &&
              (($0[kCGWindowBounds as String] as? [String: CGFloat])?["Width"] ?? 0) >= 500
          }),
          let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
          let x = bounds["X"], let y = bounds["Y"], let w = bounds["Width"], let h = bounds["Height"],
          let screen = NSScreen.screens.first
    else { panel.orderOut(nil); return }
    // shortcut: bottom-centre attachment, use a public composer slot if Codex adds one.
    let origin = NSPoint(x: x + (w - 330) / 2, y: screen.frame.maxY - y - h + 5)
    panel.setFrameOrigin(origin)
    panel.orderFrontRegardless()
}
RunLoop.main.add(timer, forMode: .common)
app.run()
close(fd)
