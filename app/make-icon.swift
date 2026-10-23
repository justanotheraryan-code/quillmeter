// Draws the Quillmeter app icon (a gauge with a needle) as a 1024x1024 PNG: make-icon <out.png>
import AppKit

let side = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4,
                                 hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let gc = NSGraphicsContext(bitmapImageRep: rep) else { fatalError("no bitmap context") }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = gc

let s = CGFloat(side)
let body = NSBezierPath(roundedRect: CGRect(x: 100, y: 100, width: s - 200, height: s - 200), xRadius: 185, yRadius: 185)
NSGradient(colors: [NSColor(srgbRed: 0.13, green: 0.17, blue: 0.31, alpha: 1), NSColor(srgbRed: 0.04, green: 0.06, blue: 0.13, alpha: 1)])!.draw(in: body, angle: -90)

let c = CGPoint(x: s / 2, y: s / 2 - 20), r: CGFloat = 235
func arc(_ from: CGFloat, _ to: CGFloat, _ color: NSColor, _ width: CGFloat) {
    let p = NSBezierPath()
    p.appendArc(withCenter: c, radius: r, startAngle: from, endAngle: to, clockwise: true)
    p.lineWidth = width
    p.lineCapStyle = .round
    color.setStroke()
    p.stroke()
}
let sweep: CGFloat = 240, start: CGFloat = 210, level: CGFloat = 0.68
arc(start, start - sweep, NSColor(white: 1, alpha: 0.16), 58)
arc(start, start - sweep * level, NSColor(srgbRed: 0.25, green: 0.78, blue: 0.88, alpha: 1), 58)

// needle: a slim tapered blade (the quill) pointing at the current level
let a = (start - sweep * level) * .pi / 180
let dir = CGPoint(x: cos(a), y: sin(a)), perp = CGPoint(x: -sin(a), y: cos(a))
let tip = CGPoint(x: c.x + dir.x * (r - 30), y: c.y + dir.y * (r - 30))
let needle = NSBezierPath()
needle.move(to: CGPoint(x: c.x + perp.x * 20, y: c.y + perp.y * 20))
needle.line(to: tip)
needle.line(to: CGPoint(x: c.x - perp.x * 20, y: c.y - perp.y * 20))
needle.close()
NSColor.white.setFill()
needle.fill()
NSBezierPath(ovalIn: CGRect(x: c.x - 42, y: c.y - 42, width: 84, height: 84)).fill()
NSColor(srgbRed: 0.09, green: 0.12, blue: 0.24, alpha: 1).setFill()
NSBezierPath(ovalIn: CGRect(x: c.x - 16, y: c.y - 16, width: 32, height: 32)).fill()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
