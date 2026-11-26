import AppKit

final class FixtureController: NSObject, NSTextFieldDelegate, NSTextViewDelegate {
    let statusPath: String
    let statusLabel: NSTextField
    let editableField: NSTextField
    let multilineView: NSTextView
    let secureField: NSSecureTextField
    let disabledField: NSTextField
    let readOnlyField: NSTextField

    init(
        statusPath: String,
        statusLabel: NSTextField,
        editableField: NSTextField,
        multilineView: NSTextView,
        secureField: NSSecureTextField,
        disabledField: NSTextField,
        readOnlyField: NSTextField
    ) {
        self.statusPath = statusPath
        self.statusLabel = statusLabel
        self.editableField = editableField
        self.multilineView = multilineView
        self.secureField = secureField
        self.disabledField = disabledField
        self.readOnlyField = readOnlyField
        super.init()
        writeStatus()
    }

    func writeStatus() {
        let dict: [String: Any] = [
            "editable": editableField.stringValue,
            "multiline": multilineView.string,
            "secure": secureField.stringValue,
            "disabled": disabledField.stringValue,
            "readOnly": readOnlyField.stringValue,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: statusPath), options: .atomic)
        }
        statusLabel.stringValue = "edit:\(editableField.stringValue.count) multi:\(multilineView.string.count)"
    }

    func controlTextDidChange(_ obj: Notification) {
        writeStatus()
    }

    func textDidChange(_ notification: Notification) {
        writeStatus()
    }
}

let statusPath = CommandLine.arguments.dropFirst().first ?? "/tmp/forgeorbit-cu05-status.json"
let app = NSApplication.shared
app.setActivationPolicy(.regular)

let statusLabel = NSTextField(labelWithString: "initializing")
statusLabel.identifier = NSUserInterfaceItemIdentifier("cu05-status-label")
statusLabel.setAccessibilityIdentifier("cu05-status-label")

// 1. Normal editable NSTextField
let editableField = NSTextField(string: "")
editableField.identifier = NSUserInterfaceItemIdentifier("cu05-editable-text")
editableField.setAccessibilityIdentifier("cu05-editable-text")
editableField.isEditable = true
editableField.isEnabled = true
editableField.placeholderString = "Editable input"

// 2. Editable multiline NSTextView in NSScrollView
let multilineScrollView = NSScrollView(frame: NSRect(x: 20, y: 180, width: 440, height: 100))
multilineScrollView.hasVerticalScroller = true
let multilineView = NSTextView(frame: multilineScrollView.bounds)
multilineView.identifier = NSUserInterfaceItemIdentifier("cu05-multiline-text")
multilineView.setAccessibilityIdentifier("cu05-multiline-text")
multilineView.setAccessibilityLabel("Multiline input")
multilineView.isEditable = true
multilineView.string = ""
multilineScrollView.documentView = multilineView

// 3. NSSecureTextField
let secureField = NSSecureTextField(string: "")
secureField.identifier = NSUserInterfaceItemIdentifier("cu05-secure-text")
secureField.setAccessibilityIdentifier("cu05-secure-text")
secureField.setAccessibilityLabel("Secure input")
secureField.isEditable = true
secureField.isEnabled = true
secureField.placeholderString = "Secret input"

// 4. Disabled text field
let disabledField = NSTextField(string: "Disabled default")
disabledField.identifier = NSUserInterfaceItemIdentifier("cu05-disabled-text")
disabledField.setAccessibilityIdentifier("cu05-disabled-text")
disabledField.setAccessibilityLabel("Disabled input")
disabledField.isEnabled = false

// 5. Read-only text field
let readOnlyField = NSTextField(string: "Read-only default")
readOnlyField.identifier = NSUserInterfaceItemIdentifier("cu05-readonly-text")
readOnlyField.setAccessibilityIdentifier("cu05-readonly-text")
readOnlyField.setAccessibilityLabel("Read only input")
readOnlyField.isEditable = false
readOnlyField.isEnabled = true

let controller = FixtureController(
    statusPath: statusPath,
    statusLabel: statusLabel,
    editableField: editableField,
    multilineView: multilineView,
    secureField: secureField,
    disabledField: disabledField,
    readOnlyField: readOnlyField
)

editableField.delegate = controller
multilineView.delegate = controller
secureField.delegate = controller

// Periodic timer to sync status if AX writes don't trigger controlTextDidChange synchronously
let timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
    controller.writeStatus()
}
RunLoop.main.add(timer, forMode: .common)

let content = NSView(frame: NSRect(x: 0, y: 0, width: 480, height: 460))
statusLabel.frame = NSRect(x: 20, y: 420, width: 440, height: 24)
editableField.frame = NSRect(x: 20, y: 380, width: 440, height: 24)
multilineScrollView.frame = NSRect(x: 20, y: 260, width: 440, height: 100)
secureField.frame = NSRect(x: 20, y: 210, width: 440, height: 24)
disabledField.frame = NSRect(x: 20, y: 160, width: 440, height: 24)
readOnlyField.frame = NSRect(x: 20, y: 110, width: 440, height: 24)

content.addSubview(statusLabel)
content.addSubview(editableField)
content.addSubview(multilineScrollView)
content.addSubview(secureField)
content.addSubview(disabledField)
content.addSubview(readOnlyField)

let window = NSWindow(
    contentRect: NSRect(x: 100, y: 100, width: 480, height: 460),
    styleMask: [.titled, .closable, .miniaturizable],
    backing: .buffered,
    defer: false
)
window.title = "ForgeOrbit Native CU05 Fixture"
window.contentView = content
window.isReleasedWhenClosed = false
window.orderFrontRegardless()
app.activate(ignoringOtherApps: true)
app.run()
