import AppKit

/// Target B — excluded application or control.
/// Represents a prohibited action category using reliable test metadata.
/// Attempted press must be refused. Counter must remain zero.

final class TargetBController: NSObject {
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

let statusPath = CommandLine.arguments.dropFirst().first ?? "/tmp/forgeorbit-target-b-status.txt"
try? "idle:0\n".write(toFile: statusPath, atomically: true, encoding: .utf8)
fputs("bundle=\(Bundle.main.bundleIdentifier ?? "nil") status=\(statusPath)\n", stderr)

let app = NSApplication.shared
app.setActivationPolicy(.regular)

let status = NSTextField(labelWithString: "idle")
status.identifier = NSUserInterfaceItemIdentifier("target-b-status")
status.setAccessibilityIdentifier("target-b-status")
let controller = TargetBController(status: status, path: statusPath)

let caption = NSTextField(labelWithString: "Excluded Target B")
let button = NSButton(title: "Prohibited action", target: controller, action: #selector(TargetBController.press(_:)))
button.identifier = NSUserInterfaceItemIdentifier("excluded-prohibited-button")
button.setAccessibilityIdentifier("excluded-prohibited-button")
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
window.title = "ForgeOrbit Native Excluded Target B"
window.contentView = content
window.isReleasedWhenClosed = false
window.orderFrontRegardless()
app.activate(ignoringOtherApps: true)
app.run()
