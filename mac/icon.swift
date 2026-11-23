// Desenha o ícone do app (1024×1024): claquete estilizada com o "play" do Takes.
import AppKit

let size: CGFloat = 1024
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let ctx = NSGraphicsContext.current!.cgContext

// Fundo arredondado no grid de ícones do macOS (824 px com margem).
let inset: CGFloat = 100
let body = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let shape = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.35).cgColor)
ctx.addPath(shape)
ctx.setFillColor(NSColor(red: 0.11, green: 0.10, blue: 0.09, alpha: 1).cgColor)
ctx.fillPath()
ctx.restoreGState()

ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [
    NSColor(red: 0.20, green: 0.18, blue: 0.16, alpha: 1).cgColor,
    NSColor(red: 0.08, green: 0.075, blue: 0.07, alpha: 1).cgColor,
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size - inset), end: CGPoint(x: 0, y: inset), options: [])

// Faixa da claquete com listras âmbar.
let amber = NSColor(red: 0.95, green: 0.69, blue: 0.29, alpha: 1).cgColor
let band = CGRect(x: inset, y: size - inset - 210, width: size - inset * 2, height: 120)
ctx.setFillColor(amber)
ctx.fill(band)
ctx.setFillColor(NSColor(red: 0.11, green: 0.10, blue: 0.09, alpha: 1).cgColor)
var x = band.minX - 60
while x < band.maxX {
    let stripe = CGMutablePath()
    stripe.move(to: CGPoint(x: x, y: band.minY))
    stripe.addLine(to: CGPoint(x: x + 70, y: band.minY))
    stripe.addLine(to: CGPoint(x: x + 140, y: band.maxY))
    stripe.addLine(to: CGPoint(x: x + 70, y: band.maxY))
    stripe.closeSubpath()
    ctx.addPath(stripe)
    ctx.fillPath()
    x += 140
}

// Três "blocos" em sequência sob o play: a ideia de cena contínua.
ctx.setFillColor(amber.copy(alpha: 0.35)!)
for i in 0..<3 {
    let w: CGFloat = 200, gap: CGFloat = 24
    let total = w * 3 + gap * 2
    let r = CGRect(x: (size - total) / 2 + CGFloat(i) * (w + gap), y: inset + 110, width: w, height: 44)
    ctx.addPath(CGPath(roundedRect: r, cornerWidth: 14, cornerHeight: 14, transform: nil))
    ctx.fillPath()
}

// Triângulo de play.
let play = CGMutablePath()
let cx = size / 2 + 30, cy = size / 2 - 40, r: CGFloat = 200
play.move(to: CGPoint(x: cx - r * 0.75, y: cy + r))
play.addLine(to: CGPoint(x: cx + r, y: cy))
play.addLine(to: CGPoint(x: cx - r * 0.75, y: cy - r))
play.closeSubpath()
ctx.addPath(play)
ctx.setFillColor(amber)
ctx.fillPath()
ctx.restoreGState()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
