import AppKit

/// Target A — eligible generic application.
/// Different bundle ID from the original fixture. One harmless AXPress button.
/// Observable counter starting at zero. Button press changes counter to one.

final class TargetAController: NSObject {
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

let statusPath = CommandLine.arguments.dropFirst().first ?? "/tmp/forgeorbit-target-a-status.txt"
try? "idle:0\n".write(toFile: statusPath, atomically: true, encoding: .utf8)
fputs("bundle=\(Bundle.main.bundleIdentifier ?? "nil") status=\(statusPath)\n", stderr)

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let status = NSTextField(labelWithString: "idle")
status.identifier = NSUserInterfaceItemIdentifier("target-a-status")
status.setAccessibilityIdentifier("target-a-status")
let controller = TargetAController(status: status, path: statusPath)

let caption = NSTextField(labelWithString: "Generic Target A")
let button = NSButton(title: "Generic press", target: controller, action: #selector(TargetAController.press(_:)))
button.identifier = NSUserInterfaceItemIdentifier("generic-press-button")
button.setAccessibilityIdentifier("generic-press-button")
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
window.title = "ForgeOrbit Native Generic Target A"
window.contentView = content
window.isReleasedWhenClosed = false
window.orderFrontRegardless()
app.activate(ignoringOtherApps: true)
app.run()
