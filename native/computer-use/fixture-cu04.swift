import AppKit

final class FixtureController: NSObject, NSTabViewDelegate {
    let statusPath: String
    var pressCount = 0
    var activeTab = "Tab 1"
    var scrollY: CGFloat = 0.0
    let statusLabel: NSTextField

    init(statusPath: String, statusLabel: NSTextField) {
        self.statusPath = statusPath
        self.statusLabel = statusLabel
        super.init()
        writeStatus()
    }

    func writeStatus() {
        let content = "button:\(pressCount) tab:\(activeTab) scrollY:\(Int(scrollY))\n"
        try? content.write(toFile: statusPath, atomically: true, encoding: .utf8)
        statusLabel.stringValue = content.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    @objc func press(_ sender: Any?) {
        pressCount += 1
        writeStatus()
    }

    func tabView(_ tabView: NSTabView, didSelect tabViewItem: NSTabViewItem?) {
        if let label = tabViewItem?.label {
            activeTab = label
            writeStatus()
        }
    }

    @objc func boundsDidChange(_ notification: Notification) {
        if let clipView = notification.object as? NSClipView {
            scrollY = clipView.bounds.origin.y
            writeStatus()
        }
    }
}

let statusPath = CommandLine.arguments.dropFirst().first ?? "/tmp/forgeorbit-cu04-status.txt"
let app = NSApplication.shared
app.setActivationPolicy(.regular)

let statusLabel = NSTextField(labelWithString: "initializing")
statusLabel.identifier = NSUserInterfaceItemIdentifier("cu04-status-label")
statusLabel.setAccessibilityIdentifier("cu04-status-label")

let controller = FixtureController(statusPath: statusPath, statusLabel: statusLabel)

// 1. Harmless button
let button = NSButton(title: "Harmless press", target: controller, action: #selector(FixtureController.press(_:)))
button.identifier = NSUserInterfaceItemIdentifier("cu04-button")
button.setAccessibilityIdentifier("cu04-button")
button.bezelStyle = .rounded

// 2. Tab view with 2 tabs
let tabView = NSTabView(frame: NSRect(x: 20, y: 180, width: 440, height: 180))
tabView.identifier = NSUserInterfaceItemIdentifier("cu04-tabview")
tabView.setAccessibilityIdentifier("cu04-tabview")
tabView.delegate = controller

let tab1 = NSTabViewItem(identifier: "tab1")
tab1.label = "Tab 1"
let tab1View = NSView(frame: tabView.bounds)
let tab1Label = NSTextField(labelWithString: "Content of Tab 1")
tab1Label.frame = NSRect(x: 20, y: 60, width: 200, height: 24)
tab1View.addSubview(tab1Label)
tab1.view = tab1View

let tab2 = NSTabViewItem(identifier: "tab2")
tab2.label = "Tab 2"
let tab2View = NSView(frame: tabView.bounds)
let tab2Label = NSTextField(labelWithString: "Content of Tab 2")
tab2Label.frame = NSRect(x: 20, y: 60, width: 200, height: 24)
tab2View.addSubview(tab2Label)
tab2.view = tab2View

tabView.addTabViewItem(tab1)
tabView.addTabViewItem(tab2)

// 3. Scroll view with enough content to scroll
let scrollView = NSScrollView(frame: NSRect(x: 20, y: 20, width: 440, height: 140))
scrollView.identifier = NSUserInterfaceItemIdentifier("cu04-scrollview")
scrollView.setAccessibilityIdentifier("cu04-scrollview")
scrollView.hasVerticalScroller = true
scrollView.autohidesScrollers = false

class FlippedView: NSView {
    override var isFlipped: Bool { return true }
}

let docView = FlippedView(frame: NSRect(x: 0, y: 0, width: 420, height: 1000))
for i in 0..<25 {
    let itemLabel = NSTextField(labelWithString: "Scroll item line \(i + 1)")
    itemLabel.frame = NSRect(x: 10, y: i * 38, width: 200, height: 20)
    docView.addSubview(itemLabel)
}
scrollView.documentView = docView
scrollView.contentView.postsBoundsChangedNotifications = true
NotificationCenter.default.addObserver(controller, selector: #selector(FixtureController.boundsDidChange(_:)), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)

// Main content
let content = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 440))
button.frame = NSRect(x: 20, y: 390, width: 160, height: 32)
statusLabel.frame = NSRect(x: 200, y: 395, width: 260, height: 24)

content.addSubview(button)
content.addSubview(statusLabel)
content.addSubview(tabView)
content.addSubview(scrollView)

let window = NSWindow(
    contentRect: NSRect(x: 100, y: 100, width: 480, height: 440),
    styleMask: [.titled, .closable, .miniaturizable],
    backing: .buffered,
    defer: false
)
window.title = "ForgeOrbit Native CU04 Fixture"
window.contentView = content
window.isReleasedWhenClosed = false
window.orderFrontRegardless()
app.activate(ignoringOtherApps: true)
app.run()
