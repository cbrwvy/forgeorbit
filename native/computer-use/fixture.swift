import AppKit

/// Disposable FO-NATIVE-CU01 target. One window, one label, one harmless button.
/// The button changes a status label and writes a counter file. It does nothing else.
final class FixtureController: NSObject {
    let status: NSTextField
    let path: String
    var count = 0

    init(status: NSTextField, path: String) {
        self.status = status
        self.path = path
    }

    @objc func press(_ sender: Any?) {
        count += 1
        status.stringValue = "pressed"
        try? "pressed:\(count)\n".write(toFile: path, atomically: true, encoding: .utf8)
    }
}

let statusPath = CommandLine.arguments.dropFirst().first ?? "/tmp/forgeorbit-native-cu-status.txt"
try? "idle:0\n".write(toFile: statusPath, atomically: true, encoding: .utf8)
fputs("bundle=\(Bundle.main.bundleIdentifier ?? "nil") status=\(statusPath)\n", stderr)

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let status = NSTextField(labelWithString: "idle")
status.identifier = NSUserInterfaceItemIdentifier("forgeorbit-native-cu-status")
status.setAccessibilityIdentifier("forgeorbit-native-cu-status")
let controller = FixtureController(status: status, path: statusPath)

let caption = NSTextField(labelWithString: "ForgeOrbit fixture")
let button = NSButton(title: "Harmless press", target: controller, action: #selector(FixtureController.press(_:)))
button.identifier = NSUserInterfaceItemIdentifier("forgeorbit-native-cu-press")
button.setAccessibilityIdentifier("forgeorbit-native-cu-press")
button.bezelStyle = .rounded

let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 160))
caption.frame = NSRect(x: 20, y: 110, width: 380, height: 24)
button.frame = NSRect(x: 20, y: 64, width: 180, height: 32)
status.frame = NSRect(x: 20, y: 24, width: 380, height: 24)
content.addSubview(caption)
content.addSubview(button)
content.addSubview(status)

let window = NSWindow(
    contentRect: NSRect(x: 80, y: 80, width: 420, height: 160),
    styleMask: [.titled, .closable, .miniaturizable],
    backing: .buffered,
    defer: false
)
window.title = "ForgeOrbit Native CU Fixture"
window.contentView = content
window.isReleasedWhenClosed = false
window.orderFrontRegardless()
app.activate(ignoringOtherApps: true)
app.run()
