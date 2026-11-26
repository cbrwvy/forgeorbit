import AppKit

final class FixtureController: NSObject, NSApplicationDelegate {
    let statusPath: String
    let statusLabel: NSTextField
    var counter: Int = 0

    init(statusPath: String, statusLabel: NSTextField) {
        self.statusPath = statusPath
        self.statusLabel = statusLabel
        super.init()
        writeStatus()
    }

    deinit {
        fputs(">>> FixtureController DEINITED! <<<\n", stderr)
    }

    func writeStatus() {
        let dict: [String: Any] = [
            "counter": counter,
            "lastAction": "count:\(counter)",
        ]
        if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: statusPath), options: .atomic)
        }
        statusLabel.stringValue = "counter: \(counter)"
    }

    @objc func harmlessAction(_ sender: Any?) {
        counter += 1
        writeStatus()
    }

    @objc func disabledAction(_ sender: Any?) {
        // Disabled action should never be invoked
    }
}

let statusPath = CommandLine.arguments.dropFirst().first ?? "/tmp/forgeorbit-cu06-status.json"
let app = NSApplication.shared
app.setActivationPolicy(.regular)

let statusLabel = NSTextField(labelWithString: "initializing")
statusLabel.identifier = NSUserInterfaceItemIdentifier("cu06-status-label")
statusLabel.setAccessibilityIdentifier("cu06-status-label")
statusLabel.setAccessibilityLabel("Status Label")

let controller = FixtureController(statusPath: statusPath, statusLabel: statusLabel)
app.delegate = controller

let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    controller.writeStatus()
}
RunLoop.main.add(timer, forMode: .common)

// Setup main menu bar
let mainMenu = NSMenu()
mainMenu.autoenablesItems = false

// 0. App menu
let appMenuItem = NSMenuItem()
let appMenu = NSMenu(title: "ForgeOrbitNativeCu06Fixture")
appMenu.autoenablesItems = false
let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
appMenu.addItem(quitItem)
appMenuItem.submenu = appMenu
mainMenu.addItem(appMenuItem)

// 1. View menu
let viewMenuItem = NSMenuItem()
viewMenuItem.title = "View"
let viewMenu = NSMenu(title: "View")
viewMenu.autoenablesItems = false

// 1.1 Harmless menu item
let harmlessItem = NSMenuItem(title: "Harmless Menu Action", action: #selector(FixtureController.harmlessAction(_:)), keyEquivalent: "")
harmlessItem.target = controller
harmlessItem.identifier = NSUserInterfaceItemIdentifier("cu06-harmless-item")
harmlessItem.setAccessibilityIdentifier("cu06-harmless-item")
harmlessItem.setAccessibilityLabel("Harmless Menu Action")
harmlessItem.isEnabled = true
viewMenu.addItem(harmlessItem)

// 1.2 Disabled menu item
let disabledItem = NSMenuItem(title: "Disabled Menu Action", action: #selector(FixtureController.disabledAction(_:)), keyEquivalent: "")
disabledItem.target = controller
disabledItem.identifier = NSUserInterfaceItemIdentifier("cu06-disabled-item")
disabledItem.setAccessibilityIdentifier("cu06-disabled-item")
disabledItem.setAccessibilityLabel("Disabled Menu Action")
disabledItem.isEnabled = false
viewMenu.addItem(disabledItem)

// 1.3 Separator
viewMenu.addItem(NSMenuItem.separator())

// 1.4 Submenu item
let submenuParentItem = NSMenuItem(title: "Submenu Item", action: nil, keyEquivalent: "")
submenuParentItem.identifier = NSUserInterfaceItemIdentifier("cu06-submenu-item")
submenuParentItem.setAccessibilityIdentifier("cu06-submenu-item")
submenuParentItem.setAccessibilityLabel("Submenu Item")
let subMenu = NSMenu(title: "Submenu Item")
subMenu.autoenablesItems = false
let nestedItem = NSMenuItem(title: "Nested Item", action: #selector(FixtureController.harmlessAction(_:)), keyEquivalent: "")
nestedItem.target = controller
nestedItem.identifier = NSUserInterfaceItemIdentifier("cu06-nested-item")
nestedItem.setAccessibilityIdentifier("cu06-nested-item")
nestedItem.setAccessibilityLabel("Nested Item")
subMenu.addItem(nestedItem)
submenuParentItem.submenu = subMenu
viewMenu.addItem(submenuParentItem)

viewMenuItem.submenu = viewMenu
mainMenu.addItem(viewMenuItem)

app.mainMenu = mainMenu

// Window setup
let fallbackButton = NSButton(title: "Fallback Button", target: controller, action: #selector(FixtureController.harmlessAction(_:)))
fallbackButton.identifier = NSUserInterfaceItemIdentifier("cu06-fallback-button")
fallbackButton.setAccessibilityIdentifier("cu06-fallback-button")
fallbackButton.setAccessibilityLabel("Fallback Button")

let content = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 200))
statusLabel.frame = NSRect(x: 20, y: 130, width: 400, height: 24)
fallbackButton.frame = NSRect(x: 20, y: 70, width: 160, height: 32)
content.addSubview(statusLabel)
content.addSubview(fallbackButton)

let window = NSWindow(
    contentRect: NSRect(x: 100, y: 100, width: 440, height: 200),
    styleMask: [.titled, .closable, .miniaturizable],
    backing: .buffered,
    defer: false
)
window.title = "ForgeOrbit Native CU06 Fixture"
window.contentView = content
window.isReleasedWhenClosed = false
window.orderFrontRegardless()
app.activate(ignoringOtherApps: true)
app.run()
