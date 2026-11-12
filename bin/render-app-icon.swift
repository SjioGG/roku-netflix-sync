#!/usr/bin/env swift
// Owns the generated desktop/assets/app-icon.png and app-icon.icns.
import AppKit
import Foundation

let destination = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "desktop/assets"
try FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)
let iconset = destination + "/app-icon.iconset"
try FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)
func icon(_ size: Int) -> Data {
    // Explicit pixel dimensions keep icon output identical on Retina displays.
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                 bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                 isPlanar: false, colorSpaceName: .deviceRGB,
                                 bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let context = NSGraphicsContext.current!.cgContext
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    let background = NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 206, yRadius: 206)
    NSGradient(starting: NSColor(calibratedRed: 0.22, green: 0.44, blue: 0.92, alpha: 1),
               ending: NSColor(calibratedRed: 0.47, green: 0.28, blue: 0.91, alpha: 1))!.draw(in: background, angle: 45)
    NSColor.white.setStroke()
    let screen = NSBezierPath(roundedRect: NSRect(x: 224, y: 370, width: 576, height: 386), xRadius: 56, yRadius: 56)
    screen.lineWidth = 36
    screen.stroke()
    NSColor.white.setFill()
    NSBezierPath(roundedRect: NSRect(x: 256, y: 244, width: 512, height: 64), xRadius: 32, yRadius: 32).fill()
    // Two opposing arrows: synchronized playback, without third-party marks.
    for (y, direction) in [(610.0, 1.0), (510.0, -1.0)] {
        let arrow = NSBezierPath()
        let start = direction > 0 ? 370.0 : 654.0
        let end = direction > 0 ? 654.0 : 370.0
        arrow.move(to: NSPoint(x: start, y: y))
        arrow.line(to: NSPoint(x: end, y: y))
        arrow.move(to: NSPoint(x: end - 54 * direction, y: y + 48))
        arrow.line(to: NSPoint(x: end, y: y))
        arrow.line(to: NSPoint(x: end - 54 * direction, y: y - 48))
        arrow.lineWidth = 32
        arrow.lineCapStyle = .round
        arrow.lineJoinStyle = .round
        arrow.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}
for size in [16, 32, 128, 256, 512] {
    try icon(size).write(to: URL(fileURLWithPath: iconset + "/icon_\(size)x\(size).png"))
    try icon(size * 2).write(to: URL(fileURLWithPath: iconset + "/icon_\(size)x\(size)@2x.png"))
}
try icon(1024).write(to: URL(fileURLWithPath: destination + "/app-icon.png"))
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", iconset, "-o", destination + "/app-icon.icns"]
try process.run()
process.waitUntilExit()
if process.terminationStatus != 0 { exit(process.terminationStatus) }
try FileManager.default.removeItem(atPath: iconset)
print("Rendered Roku Sync app icon")
