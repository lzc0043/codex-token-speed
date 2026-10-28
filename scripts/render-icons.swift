import AppKit

let root = URL(fileURLWithPath: CommandLine.arguments[1])
for name in ["gauge", "database"] {
    let source = root.appendingPathComponent("source/\(name).pdf")
    guard let image = NSImage(contentsOf: source),
          let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 40, pixelsHigh: 40,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("Cannot render \(name)") }
    bitmap.size = NSSize(width: 20, height: 20)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: 2, y: 2)
    let bounds = NSRect(x: 0, y: 0, width: 20, height: 20)
    image.draw(in: bounds)
    NSColor(calibratedWhite: 0.55, alpha: 1).setFill()
    bounds.fill(using: .sourceAtop)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: root.appendingPathComponent("\(name).png"))
}
