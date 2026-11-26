import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation

/// FO-NATIVE-CU01 helper. One JSON request on stdin, one JSON object on stdout, then exit.
/// It does not run a shell, AppleScript, or a background loop.
/// Every mutation is checked against its requested application, window and control or document.

private let fixtureBundle = "app.forgeorbit.native-cu-fixture"
private let fixtureButton = "forgeorbit-native-cu-press"
private let maxElements = 80
private let maxDepth = 6
private let maxLabel = 120
private let maxApps = 40
private let maxWindows = 12
private let maxEdge = 1280
private let maxPng = 1_500_000
private let procBsdInfo: Int32 = 3

private struct Target {
    var bundleId: String
    var executablePath: String
    var pid: pid_t
    var startSec: UInt64
    var startUsec: UInt64
}

private func emit(_ object: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [])
    FileHandle.standardOutput.write(data)
    exit(0)
}

private func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "message": message])
}

private func ok(_ result: [String: Any]) -> Never {
    emit(["ok": true, "result": result])
}

private func intValue(_ value: Any?) -> Int? {
    (value as? NSNumber)?.intValue
}

private func u64Value(_ value: Any?) -> UInt64? {
    guard let number = value as? NSNumber else { return nil }
    let parsed = number.int64Value
    if parsed < 0 { return nil }
    return UInt64(parsed)
}

private func clean(_ raw: String, limit: Int) -> String {
    let filtered = raw.unicodeScalars.map { scalar -> Character in
        scalar.value < 32 || scalar.value == 127 ? " " : Character(scalar)
    }
    let collapsed = String(filtered).split(whereSeparator: { $0 == " " }).joined(separator: " ")
    return String(collapsed.prefix(limit))
}

private func titleRecord(_ raw: String) -> (text: String, redacted: Bool) {
    let text = clean(raw, limit: 80)
    if text.range(of: "password|secret|token|cookie|keychain", options: [.regularExpression, .caseInsensitive]) != nil {
        return ("", true)
    }
    return (text, false)
}

private func processPath(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    let wrote = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    if wrote <= 0 { return nil }
    return String(cString: buffer)
}

private func processStart(_ pid: pid_t) -> (sec: UInt64, usec: UInt64, uid: uid_t)? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    if proc_pidinfo(pid, procBsdInfo, 0, &info, size) != size { return nil }
    return (info.pbi_start_tvsec, info.pbi_start_tvusec, info.pbi_uid)
}

private func readTarget(_ object: [String: Any]) -> Target? {
    guard let raw = object["target"] as? [String: Any],
          let bundleId = raw["bundleId"] as? String,
          let executablePath = raw["executablePath"] as? String,
          let pid = intValue(raw["pid"]),
          let startSec = u64Value(raw["startSec"]),
          let startUsec = u64Value(raw["startUsec"]),
          pid > 0, startUsec <= 999_999,
          executablePath.hasPrefix("/"), !executablePath.contains(".."),
          bundleId.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{0,220}$", options: .regularExpression) != nil
    else { return nil }
    return Target(bundleId: bundleId, executablePath: executablePath, pid: pid_t(pid), startSec: startSec, startUsec: startUsec)
}

private func requireTarget(_ target: Target) -> NSRunningApplication {
    guard let started = processStart(target.pid) else { fail("target_exited", "The application is no longer running.") }
    if started.uid != getuid() { fail("identity_mismatch", "The process is not owned by this user.") }
    if started.sec != target.startSec || started.usec != target.startUsec {
        fail("pid_reused", "That process id now belongs to a different process.")
    }
    guard let path = processPath(target.pid), path == target.executablePath else {
        fail("identity_mismatch", "The executable identity did not match.")
    }
    guard let app = NSRunningApplication(processIdentifier: target.pid),
          app.bundleIdentifier == target.bundleId
    else { fail("identity_mismatch", "The application bundle identity did not match.") }
    return app
}

private func plistBundleId(_ executable: String) -> String? {
    let macOS = (executable as NSString).deletingLastPathComponent
    let contents = (macOS as NSString).deletingLastPathComponent
    let plistPath = (contents as NSString).appendingPathComponent("Info.plist")
    let plist = NSDictionary(contentsOfFile: plistPath)
    return plist?["CFBundleIdentifier"] as? String
}

private func copyAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 0.25)
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, name as CFString, &value) != .success { return nil }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
    copyAttribute(element, name) as? String ?? ""
}

private func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool {
    (copyAttribute(element, name) as? NSNumber)?.boolValue ?? false
}

private func children(of element: AXUIElement) -> [AXUIElement] {
    copyAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement] ?? []
}

private func elementFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = copyAttribute(element, kAXPositionAttribute as String),
          let size = copyAttribute(element, kAXSizeAttribute as String),
          CFGetTypeID(position) == AXValueGetTypeID(),
          CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var cgSize = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &cgSize)
    else { return nil }
    return CGRect(origin: point, size: cgSize)
}

private func cgWindows(pid: pid_t) -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.filter { window in
        (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
            && (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
            && (window[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue != false
    }
}

private func windowBounds(_ window: [String: Any]) -> CGRect? {
    guard let raw = window[kCGWindowBounds as String] else { return nil }
    var rect = CGRect.zero
    guard CFGetTypeID(raw as CFTypeRef) == CFDictionaryGetTypeID(),
          CGRectMakeWithDictionaryRepresentation(raw as! CFDictionary, &rect)
    else { return nil }
    return rect
}

private func windowRecord(_ window: [String: Any], axWindow: AXUIElement? = nil) -> [String: Any]? {
    guard let windowId = (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value, windowId > 0,
          let bounds = windowBounds(window)
    else { return nil }
    var rawTitle = window[kCGWindowName as String] as? String ?? ""
    if rawTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, let axWindow = axWindow {
        rawTitle = stringAttribute(axWindow, kAXTitleAttribute as String)
    }
    let title = titleRecord(rawTitle)
    return [
        "windowId": Int(windowId),
        "title": title.text,
        "titleRedacted": title.redacted,
        "width": Int(bounds.width.rounded()),
        "height": Int(bounds.height.rounded()),
    ]
}

private func applicationWindows(_ pid: pid_t) -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    let windows = copyAttribute(app, kAXWindowsAttribute as String) as? [AXUIElement]
    return windows ?? []
}

private func framesMatch(_ left: CGRect, _ right: CGRect) -> Bool {
    abs(left.origin.x - right.origin.x) < 12
        && abs(left.origin.y - right.origin.y) < 12
        && abs(left.size.width - right.size.width) < 12
        && abs(left.size.height - right.size.height) < 12
}

private func matchedAxWindow(for cg: [String: Any], in axWindows: [AXUIElement]) -> AXUIElement? {
    guard let bounds = windowBounds(cg) else { return nil }
    let matches = axWindows.filter { element in
        guard let frame = elementFrame(element) else { return false }
        return framesMatch(frame, bounds)
    }
    return matches.count == 1 ? matches.first : nil
}

private func matchWindow(pid: pid_t, windowId: Int) -> (cg: [String: Any], ax: AXUIElement) {
    if !AXIsProcessTrusted() { fail("accessibility_denied", "Accessibility access is not available.") }
    let matches = cgWindows(pid: pid).filter { (window: [String: Any]) in
        (window[kCGWindowNumber as String] as? NSNumber)?.uint32Value == UInt32(windowId)
    }
    guard matches.count == 1, let cg = matches.first, let bounds = windowBounds(cg) else {
        fail("window_not_found", "That window is no longer available.")
    }
    let ax = applicationWindows(pid).filter { element in
        guard let frame = elementFrame(element) else { return false }
        return framesMatch(frame, bounds)
    }
    guard ax.count == 1, let element = ax.first else {
        fail("window_mismatch", "The window identity did not match an accessibility window.")
    }
    return (cg, element)
}

private func labelHash(role: String, identifier: String, label: String) -> String {
    let text = "\(role)\n\(identifier)\n\(label)"
    let digest = Array(SHA256.hash(data: Data(text.utf8)))
    return digest.prefix(8).map { String(format: "%02x", $0) }.joined()
}

private func elementSupportsPress(_ element: AXUIElement) -> Bool {
    var actionNames: CFArray?
    AXUIElementSetMessagingTimeout(element, 0.25)
    if AXUIElementCopyActionNames(element, &actionNames) == .success,
       let names = actionNames as? [String] {
        return names.contains(kAXPressAction as String)
    }
    return false
}

private func isExcludedTarget(bundleId: String, executablePath: String) -> (excluded: Bool, reason: String) {
    let lowerBundle = bundleId.lowercased()
    let lowerPath = executablePath.lowercased()

    if bundleId == "app.forgeorbit" || bundleId == "app.forgeorbit.qa"
        || bundleId == "app.forgeorbit.desktop" || bundleId == "app.forgeorbit.local"
        || lowerPath.contains("forgeorbit.app") {
        return (true, "ForgeOrbit cannot target its own application controls.")
    }

    if bundleId == "app.forgeorbit.native-cu-excluded"
        || bundleId == "app.forgeorbit.native-cu-target-b"
        || lowerBundle.contains(".native-cu-excluded") {
        return (true, "Target is in an excluded application test category.")
    }

    let securityBundles = [
        "com.apple.securityagent",
        "com.apple.coreauthui",
        "com.apple.usernotificationcenter",
        "com.apple.systempreferences",
        "com.apple.systemsettings",
        "com.apple.preference.security",
        "com.apple.keychainaccess",
        "com.apple.authorizationhost"
    ]
    for sec in securityBundles {
        if lowerBundle == sec || lowerBundle.hasPrefix(sec + ".") {
            return (true, "macOS security and system settings dialogs are excluded.")
        }
    }
    if lowerBundle.contains("localauthentication") || lowerBundle.contains("authenticationservices") || lowerBundle.contains(".tcc.") {
        return (true, "Authentication and authorization dialogs are excluded.")
    }

    let passwordManagers = [
        "com.1password",
        "com.agilebits",
        "com.bitwarden",
        "com.lastpass",
        "org.keepassxc",
        "com.enpass",
        "com.dashlane",
        "com.nordpass"
    ]
    for pm in passwordManagers {
        if lowerBundle.hasPrefix(pm) {
            return (true, "Password managers and credential stores are excluded.")
        }
    }

    let terminals = [
        "com.apple.terminal",
        "com.googlecode.iterm2",
        "dev.warp.warp-stable",
        "dev.warp.warp",
        "net.kovidgoyal.kitty",
        "com.mitchellh.ghostty",
        "io.alacritty"
    ]
    for term in terminals {
        if lowerBundle == term || lowerBundle.hasPrefix(term + ".") {
            return (true, "Terminal and shell execution interfaces are excluded.")
        }
    }

    if lowerPath.hasPrefix("/bin/") || lowerPath.hasPrefix("/sbin/")
        || lowerPath.hasPrefix("/usr/bin/") || lowerPath.hasPrefix("/usr/sbin/") {
        return (true, "System command line shells are excluded.")
    }

    return (false, "")
}

private func isExcludedWindow(title: String, titleRedacted: Bool) -> (excluded: Bool, reason: String) {
    if titleRedacted {
        return (true, "Windows with redacted credentials or secrets cannot be targeted.")
    }
    let lower = title.lowercased()
    let sensitiveWords = ["password", "keychain", "security", "authentication", "credential", "authorization", "grant permission"]
    for word in sensitiveWords {
        if lower.contains(word) {
            return (true, "Security and credential management windows are excluded.")
        }
    }
    return (false, "")
}

private func isExcludedElement(role: String, subrole: String, identifier: String, label: String) -> (excluded: Bool, reason: String) {
    if role != "AXButton" && role != "AXScrollArea" && role != "AXRadioButton" && role != "AXTab" && role != "AXTextField" && role != "AXTextArea" && role != "AXMenuBarItem" && role != "AXMenuItem" {
        return (true, "Only accessible buttons, scroll areas, tabs, text fields, and menus can be operated.")
    }
    let lowerRole = role.lowercased()
    let lowerSubrole = subrole.lowercased()
    if lowerRole.contains("secure") || lowerRole.contains("password") || lowerSubrole.contains("secure") || lowerSubrole.contains("password") {
        return (true, "Secure and password controls are excluded.")
    }
    if role == "AXMenuBarItem" && (label.lowercased() == "apple" || label == "" || identifier.lowercased() == "apple") {
        return (true, "System Apple menu is excluded.")
    }
    let hay = "\(identifier.lowercased()) \(label.lowercased())"
    let sensitiveTerms = [
        "password", "passcode", "secret", "token", "keychain", "credential", "auth",
        "login", "signin", "sign-in", "tcc", "permission", "grant-access",
        "erase-all", "format-disk", "delete-account", "factory-reset",
        "excluded", "prohibited", "verification", "otp", "mfa", "2fa", "pin",
        "terminal", "shell", "sudo", "admin", "wipe"
    ]
    for term in sensitiveTerms {
        if hay.range(of: "\\b\(term)\\b", options: .regularExpression) != nil || identifier.lowercased().contains(term) {
            return (true, "Security-sensitive, authentication, or prohibited controls are excluded.")
        }
    }
    return (false, "")
}

private func isProtectedField(role: String, subrole: String, identifier: String) -> Bool {
    if role.localizedCaseInsensitiveContains("secure")
        || role.localizedCaseInsensitiveContains("password")
        || subrole.localizedCaseInsensitiveContains("secure")
        || subrole.localizedCaseInsensitiveContains("password")
    {
        return true
    }
    if role == "AXTextField" || role == "AXTextArea" || role == "AXStaticText" {
        let lowerId = identifier.lowercased()
        let protectedTerms = ["password", "passcode", "secret", "token", "credential", "keychain", "otp", "mfa", "2fa", "pin"]
        if protectedTerms.contains(where: { lowerId.contains($0) }) {
            return true
        }
    }
    return false
}

private func elementLabel(_ element: AXUIElement, role: String, identifier: String = "") -> (text: String, redacted: Bool) {
    let subrole = stringAttribute(element, kAXSubroleAttribute as String)
    if isProtectedField(role: role, subrole: subrole, identifier: identifier) {
        return ("", true)
    }
    let title = stringAttribute(element, kAXTitleAttribute as String)
    let description = stringAttribute(element, kAXDescriptionAttribute as String)
    let help = stringAttribute(element, kAXHelpAttribute as String)
    let placeholder = stringAttribute(element, "AXPlaceholderValue")
    var label = [title, description, help, placeholder].first(where: { !$0.isEmpty }) ?? ""
    if role == "AXStaticText" && label.isEmpty {
        label = stringAttribute(element, kAXValueAttribute as String)
    }
    return (clean(label, limit: maxLabel), false)
}

private func walk(_ element: AXUIElement, path: String, depth: Int, parentRole: String, remaining: inout Int, out: inout [[String: Any]], omitted: inout Int, truncated: inout Bool) {
    if depth > maxDepth || remaining <= 0 {
        truncated = true
        omitted += 1
        return
    }
    remaining -= 1
    let role = stringAttribute(element, kAXRoleAttribute as String)
    let safeRole = role.isEmpty ? "AXUnknown" : clean(role, limit: 80)
    let subrole = clean(stringAttribute(element, kAXSubroleAttribute as String), limit: 80)
    let identifier = clean(stringAttribute(element, kAXIdentifierAttribute as String), limit: 120)
    let label = elementLabel(element, role: safeRole, identifier: identifier)
    if !path.isEmpty {
        let supportsPress = (safeRole == "AXButton") ? elementSupportsPress(element) : false
        var supportsScroll = false
        var enabled = boolAttribute(element, kAXEnabledAttribute as String)
        if safeRole == "AXScrollArea" {
            if let vScroll = copyAttribute(element, kAXVerticalScrollBarAttribute as String) {
                let vScrollElem = vScroll as! AXUIElement
                var settable: DarwinBoolean = false
                if AXUIElementIsAttributeSettable(vScrollElem, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
                    supportsScroll = true
                }
                enabled = boolAttribute(vScrollElem, kAXEnabledAttribute as String)
            }
        }
        let inTabGroup = (parentRole == "AXTabGroup" || subrole == "AXTabButton")
        let supportsSelectTab = (safeRole == "AXRadioButton" || safeRole == "AXTab") && inTabGroup && elementSupportsPress(element)
        var supportsSetText = false
        if (safeRole == "AXTextField" || safeRole == "AXTextArea") && !label.redacted {
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
                if safeRole == "AXTextArea" {
                    enabled = true
                    supportsSetText = true
                } else if enabled {
                    supportsSetText = true
                }
            }
        }
        out.append([
            "path": path,
            "role": safeRole,
            "subrole": subrole,
            "parentRole": parentRole,
            "identifier": identifier,
            "label": label.text,
            "labelHash": labelHash(role: safeRole, identifier: identifier, label: label.text),
            "enabled": enabled,
            "depth": depth,
            "valueRedacted": label.redacted,
            "supportsPress": supportsPress,
            "supportsScroll": supportsScroll,
            "supportsSelectTab": supportsSelectTab,
            "supportsSetText": supportsSetText,
            "isMultiline": (safeRole == "AXTextArea"),
            "inTabGroup": inTabGroup,
        ])
    }
    let nested = children(of: element)
    for (index, child) in nested.enumerated() {
        if out.count >= maxElements {
            truncated = true
            omitted += max(0, nested.count - index)
            return
        }
        let childPath = path.isEmpty ? "\(index)" : "\(path)/\(index)"
        walk(child, path: childPath, depth: depth + 1, parentRole: safeRole, remaining: &remaining, out: &out, omitted: &omitted, truncated: &truncated)
    }
}

private func elementAt(_ root: AXUIElement, path: String) -> AXUIElement? {
    var current = root
    for part in path.split(separator: "/") {
        guard let index = Int(part) else { return nil }
        let nested = children(of: current)
        if index < 0 || index >= nested.count { return nil }
        current = nested[index]
    }
    return current
}

private func menuElementAt(pid: pid_t, path: String) -> AXUIElement? {
    guard path.hasPrefix("menu/") else { return nil }
    let sub = path.dropFirst("menu/".count)
    let axApp = AXUIElementCreateApplication(pid)
    var mbRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(axApp, kAXMenuBarAttribute as CFString, &mbRef) == .success,
          let mbElem = mbRef as! AXUIElement?
    else { return nil }
    var current: AXUIElement = mbElem
    for part in sub.split(separator: "/") {
        guard let index = Int(part) else { return nil }
        let kids = children(of: current)
        guard index >= 0, index < kids.count else { return nil }
        current = kids[index]
    }
    return current
}

private func walkMenuBar(_ menuBar: AXUIElement, remaining: inout Int, out: inout [[String: Any]], omitted: inout Int, truncated: inout Bool) {
    let mbItems = children(of: menuBar)
    for (i, mbItem) in mbItems.enumerated() {
        if remaining <= 0 || out.count >= maxElements {
            truncated = true
            omitted += max(0, mbItems.count - i)
            return
        }
        let role = stringAttribute(mbItem, kAXRoleAttribute as String)
        let safeRole = role.isEmpty ? "AXMenuBarItem" : clean(role, limit: 80)
        let subrole = clean(stringAttribute(mbItem, kAXSubroleAttribute as String), limit: 80)
        let identifier = clean(stringAttribute(mbItem, kAXIdentifierAttribute as String), limit: 120)
        let label = elementLabel(mbItem, role: safeRole, identifier: identifier)
        if i == 0 && (label.text.lowercased() == "apple" || label.text == "" || identifier.lowercased() == "apple") {
            continue
        }
        let path = "menu/\(i)"
        let enabled = boolAttribute(mbItem, kAXEnabledAttribute as String)
        let supportsPress = elementSupportsPress(mbItem)
        let supportsOpenMenu = enabled && supportsPress && !isExcludedElement(role: safeRole, subrole: subrole, identifier: identifier, label: label.text).excluded
        remaining -= 1
        out.append([
            "path": path,
            "role": safeRole,
            "subrole": subrole,
            "parentRole": "AXMenuBar",
            "identifier": identifier,
            "label": label.text,
            "labelHash": labelHash(role: safeRole, identifier: identifier, label: label.text),
            "enabled": enabled,
            "depth": 1,
            "valueRedacted": label.redacted,
            "supportsPress": supportsPress,
            "supportsScroll": false,
            "supportsSelectTab": false,
            "supportsSetText": false,
            "supportsOpenMenu": supportsOpenMenu,
            "supportsSelectMenuItem": false,
            "isMultiline": false,
            "inTabGroup": false,
            "isSubmenu": false,
        ])

        let itemKids = children(of: mbItem)
        for (mIdx, mElem) in itemKids.enumerated() {
            let mRole = stringAttribute(mElem, kAXRoleAttribute as String)
            if mRole != "AXMenu" { continue }
            var visRef: CFTypeRef?
            let _ = AXUIElementCopyAttributeValue(mElem, "AXVisibleChildren" as CFString, &visRef)
            let visKids = visRef as? [AXUIElement] ?? []
            var selRef: CFTypeRef?
            let _ = AXUIElementCopyAttributeValue(mbItem, "AXSelected" as CFString, &selRef)
            let isSelected = (selRef as? NSNumber)?.boolValue ?? false
            let isOpen = !visKids.isEmpty || isSelected
            if !isOpen { continue }

            let menuItems = children(of: mElem)
            for (miIdx, mi) in menuItems.enumerated() {
                if remaining <= 0 || out.count >= maxElements {
                    truncated = true
                    omitted += max(0, menuItems.count - miIdx)
                    return
                }
                let miRole = stringAttribute(mi, kAXRoleAttribute as String)
                let safeMiRole = miRole.isEmpty ? "AXMenuItem" : clean(miRole, limit: 80)
                let miSubrole = clean(stringAttribute(mi, kAXSubroleAttribute as String), limit: 80)
                let miIdentifier = clean(stringAttribute(mi, kAXIdentifierAttribute as String), limit: 120)
                let miLabel = elementLabel(mi, role: safeMiRole, identifier: miIdentifier)
                let miKids = children(of: mi)
                let isSubmenu = miKids.contains { stringAttribute($0, kAXRoleAttribute as String) == "AXMenu" }
                let isSeparator = miSubrole == "AXSeparator" || (miLabel.text.isEmpty && !boolAttribute(mi, kAXEnabledAttribute as String))
                let miEnabled = boolAttribute(mi, kAXEnabledAttribute as String)
                let miSupportsPress = elementSupportsPress(mi)
                let miExcluded = isExcludedElement(role: safeMiRole, subrole: miSubrole, identifier: miIdentifier, label: miLabel.text).excluded
                let supportsSelect = miEnabled && !isSubmenu && !isSeparator && miSupportsPress && !miExcluded
                let miPath = "menu/\(i)/\(mIdx)/\(miIdx)"
                remaining -= 1
                out.append([
                    "path": miPath,
                    "role": safeMiRole,
                    "subrole": miSubrole,
                    "parentRole": "AXMenu",
                    "identifier": miIdentifier,
                    "label": miLabel.text,
                    "labelHash": labelHash(role: safeMiRole, identifier: miIdentifier, label: miLabel.text),
                    "enabled": miEnabled,
                    "depth": 2,
                    "valueRedacted": miLabel.redacted,
                    "supportsPress": miSupportsPress,
                    "supportsScroll": false,
                    "supportsSelectTab": false,
                    "supportsSetText": false,
                    "supportsOpenMenu": false,
                    "supportsSelectMenuItem": supportsSelect,
                    "isMultiline": false,
                    "inTabGroup": false,
                    "isSubmenu": isSubmenu,
                ])
            }
        }
    }
}

private func applicationRecord(_ app: NSRunningApplication) -> [String: Any]? {
    guard let bundleId = app.bundleIdentifier,
          bundleId.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{0,220}$", options: .regularExpression) != nil,
          let started = processStart(app.processIdentifier),
          started.uid == getuid(),
          let path = processPath(app.processIdentifier)
    else { return nil }
    return [
        "bundleId": bundleId,
        "executablePath": path,
        "pid": Int(app.processIdentifier),
        "startSec": started.sec,
        "startUsec": started.usec,
        "displayName": clean(app.localizedName ?? bundleId, limit: 80),
    ]
}

private func openSettings(_ kind: String) -> Bool {
    let anchor = kind == "screen-recording" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
    let urls = [
        "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?\(anchor)",
        "x-apple.systempreferences:com.apple.preference.security?\(anchor)",
    ]
    for item in urls {
        if let url = URL(string: item), NSWorkspace.shared.open(url) { return true }
    }
    return false
}

private func permissionMap() -> [String: String] {
    [
        "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
        "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
    ]
}

private func scaled(_ image: CGImage, edge: Int) -> CGImage {
    let width = image.width
    let height = image.height
    let longest = max(width, height)
    if longest <= edge { return image }
    let scale = Double(edge) / Double(longest)
    let targetWidth = max(1, Int((Double(width) * scale).rounded(.down)))
    let targetHeight = max(1, Int((Double(height) * scale).rounded(.down)))
    guard let context = CGContext(
        data: nil,
        width: targetWidth,
        height: targetHeight,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return image }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
    return context.makeImage() ?? image
}

private func pngData(_ image: CGImage) -> Data? {
    NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
}

private func captureWindow(_ windowId: Int) -> [String: Any] {
    if !CGPreflightScreenCaptureAccess() {
        return ["available": false, "reason": "screen_recording_denied", "pngBase64": "", "width": 0, "height": 0, "bytes": 0]
    }
    guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(windowId), [.boundsIgnoreFraming, .nominalResolution]) else {
        return ["available": false, "reason": "screenshot_unavailable", "pngBase64": "", "width": 0, "height": 0, "bytes": 0]
    }
    var current = scaled(image, edge: maxEdge)
    guard var data = pngData(current) else {
        return ["available": false, "reason": "screenshot_unavailable", "pngBase64": "", "width": 0, "height": 0, "bytes": 0]
    }
    if data.count > maxPng {
        current = scaled(current, edge: 640)
        data = pngData(current) ?? data
    }
    if data.count > maxPng || current.width < 2 || current.height < 2 {
        return ["available": false, "reason": "screenshot_unavailable", "pngBase64": "", "width": 0, "height": 0, "bytes": 0]
    }
    return [
        "available": true,
        "reason": "",
        "pngBase64": data.base64EncodedString(),
        "width": current.width,
        "height": current.height,
        "bytes": data.count,
    ]
}

private let textEditBundle = "com.apple.TextEdit"
private let textEditApp = URL(fileURLWithPath: "/System/Applications/TextEdit.app", isDirectory: true)
private let taskDocumentMaxBytes = 16_384

private func documentHash(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}

private func taskDocument(_ object: [String: Any]) -> (url: URL, text: String) {
    guard let root = object["workspace"] as? String, root.hasPrefix("/"),
          let relative = object["document"] as? String, relative.utf8.count <= 960,
          relative.lowercased().hasSuffix(".txt"),
          relative.split(separator: "/", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && !$0.hasPrefix(".") }),
          relative.range(of: "^[\\p{L}\\p{N}_. /-]+$", options: .regularExpression) != nil
    else { fail("document_scope", "Choose a named plain-text document inside the approved workspace.") }
    let workspace = URL(fileURLWithPath: root, isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
    let file = workspace.appendingPathComponent(relative).standardizedFileURL
    guard file.path.hasPrefix(workspace.path + "/"),
          file.resolvingSymlinksInPath().path == file.path
    else { fail("document_scope", "The document path no longer resolves inside the approved workspace.") }
    let fd = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { fail("document_scope", "The approved document is unavailable.") }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
          info.st_size >= 0, info.st_size <= taskDocumentMaxBytes
    else { fail("document_scope", "The approved .txt file must be a small regular file without additional hard links.") }
    var bytes = [UInt8](repeating: 0, count: taskDocumentMaxBytes + 1)
    let count = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
    guard count == info.st_size, let text = String(bytes: bytes.prefix(count), encoding: .utf8),
          !text.unicodeScalars.contains(where: { ($0.value < 32 && $0.value != 9 && $0.value != 10) || $0.value == 127 })
    else { fail("document_scope", "The approved document is not supported plain UTF-8 text.") }
    return (file, text)
}

private func matchedDocument(_ element: AXUIElement, file: URL) -> Bool {
    let value = stringAttribute(element, "AXDocument")
    guard let url = URL(string: value), url.isFileURL else { return false }
    return url.standardizedFileURL.path == file.path && url.resolvingSymlinksInPath().path == file.path
}

private func focusedTaskDocument(_ target: Target, _ file: URL) -> (window: AXUIElement, id: Int)? {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid,
          let focused = copyAttribute(AXUIElementCreateApplication(target.pid), "AXFocusedWindow"),
          CFGetTypeID(focused) == AXUIElementGetTypeID()
    else { return nil }
    let window = focused as! AXUIElement
    // The on-screen CG list is front to back. Pair its first TextEdit window
    // with AX's focused window; other documents can have identical bounds.
    guard matchedDocument(window, file: file),
          (copyAttribute(window, "AXSheets") as? [AXUIElement] ?? []).isEmpty,
          let cg = cgWindows(pid: target.pid).first, let bounds = windowBounds(cg),
          let frame = elementFrame(window), framesMatch(frame, bounds),
          let id = (cg[kCGWindowNumber as String] as? NSNumber)?.uint32Value, id > 0
    else { return nil }
    return (window, Int(id))
}

private func focusedDocument(_ target: Target, _ window: AXUIElement, _ file: URL, _ windowId: Int) -> Bool {
    guard let matched = focusedTaskDocument(target, file) else { return false }
    return matched.id == windowId && CFEqual(matched.window, window)
}

private func documentArea(_ root: AXUIElement, limit: inout Int, depth: Int = 0) -> [AXUIElement] {
    if limit <= 0 || depth > 8 { return [] }
    limit -= 1
    let role = stringAttribute(root, kAXRoleAttribute as String)
    if role == "AXTextArea" {
        let subrole = stringAttribute(root, kAXSubroleAttribute as String)
        return subrole == "AXSecureTextField" ? [] : [root]
    }
    if ["AXSheet", "AXDialog"].contains(role) { return [] }
    return children(of: root).flatMap { documentArea($0, limit: &limit, depth: depth + 1) }
}

private func taskDocumentWindow(_ object: [String: Any], _ file: URL) -> (Target, AXUIElement, AXUIElement, Int) {
    guard AXIsProcessTrusted() else { fail("accessibility_denied", "Allow ForgeOrbit in System Settings → Privacy & Security → Accessibility, then review the task again.") }
    guard let target = readTarget(object), target.bundleId == textEditBundle,
          target.executablePath == textEditApp.appendingPathComponent("Contents/MacOS/TextEdit").path,
          let windowId = intValue(object["windowId"]), windowId > 0, windowId <= Int(UInt32.max)
    else { fail("window_mismatch", "The approved TextEdit process and window could not be verified.") }
    _ = requireTarget(target)
    guard let matched = focusedTaskDocument(target, file), matched.id == windowId
    else { fail("window_mismatch", "Focus or the TextEdit document changed. No further action was sent.") }
    var limit = maxElements
    let areas = documentArea(matched.window, limit: &limit)
    guard areas.count == 1, let area = areas.first
    else { fail("window_mismatch", "TextEdit did not expose one verified text area for this document.") }
    return (target, matched.window, area, windowId)
}

private func taskDocumentOpen(_ object: [String: Any]) -> Never {
    guard AXIsProcessTrusted() else { fail("accessibility_denied", "Allow ForgeOrbit in System Settings → Privacy & Security → Accessibility, then review the task again.") }
    let doc = taskDocument(object)
    guard documentHash(doc.text) == object["expected"] as? String,
          Bundle(url: textEditApp)?.bundleIdentifier == textEditBundle
    else { fail("document_scope", "The approved document or system TextEdit changed since review.") }
    var app: NSRunningApplication?
    var failed = false
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    config.promptsUserIfNeeded = false
    NSWorkspace.shared.open([doc.url], withApplicationAt: textEditApp, configuration: config) { opened, error in
        app = opened
        failed = error != nil
    }
    let deadline = Date().addingTimeInterval(6)
    while Date() < deadline && !failed {
        if let app = app, let identity = applicationRecord(app),
           let target = readTarget(["target": identity]), target.bundleId == textEditBundle,
           target.executablePath == textEditApp.appendingPathComponent("Contents/MacOS/TextEdit").path,
           let matched = focusedTaskDocument(target, doc.url) {
            ok(["target": identity, "windowId": matched.id, "documentVerified": true])
        }
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.08))
    }
    fail("window_mismatch", "The selected document did not become the verified focused TextEdit window.")
}

private func taskDocumentOperation(_ command: String, _ object: [String: Any]) -> Never {
    let file = taskDocument(object)
    let (target, window, area, windowId) = taskDocumentWindow(object, file.url)
    guard let text = copyAttribute(area, kAXValueAttribute as String) as? String,
          text.utf8.count <= taskDocumentMaxBytes, let expected = object["expected"] as? String
    else { fail("document_scope", "TextEdit did not expose the approved plain-text document.") }
    if command == "task-document-read" {
        guard text == file.text, documentHash(text) == expected
        else { fail("document_scope", "The document or its open contents changed since review.") }
        ok(["verified": true])
    }
    if command == "task-document-edit" {
        guard object["writable"] as? Bool == true,
              let find = object["find"] as? String, !find.isEmpty, find.utf8.count <= 640,
              let replace = object["replace"] as? String, replace.utf8.count <= 640,
              find != replace, documentHash(file.text) == expected, text == file.text,
              let range = text.range(of: find, options: .literal),
              let next = text.unicodeScalars.index(range.lowerBound, offsetBy: 1, limitedBy: text.endIndex),
              text.range(of: find, options: .literal, range: next..<text.endIndex) == nil
        else { fail("document_scope", "The authorized text must occur exactly once in the unchanged document.") }
        let changed = text.replacingCharacters(in: range, with: replace)
        var settable: DarwinBoolean = false
        guard changed.utf8.count <= taskDocumentMaxBytes,
              AXUIElementIsAttributeSettable(area, kAXValueAttribute as CFString, &settable) == .success,
              settable.boolValue, focusedDocument(target, window, file.url, windowId)
        else { fail("window_mismatch", "The selected document is no longer focused or editable.") }
        guard AXUIElementSetAttributeValue(area, kAXValueAttribute as CFString, changed as CFString) == .success,
              (copyAttribute(area, kAXValueAttribute as String) as? String) == changed
        else { fail("action_uncertain", "TextEdit did not confirm the requested edit. Inspect the document before trying again.") }
        ok(["edited": true, "digest": documentHash(changed)])
    }
    guard object["writable"] as? Bool == true, let edited = object["edited"] as? String,
          documentHash(text) == edited, [expected, edited].contains(documentHash(file.text))
    else { fail("document_scope", "The document changed before saving.") }
    if documentHash(file.text) == edited { ok(["saved": true]) } // TextEdit may have already autosaved.
    let app = AXUIElementCreateApplication(target.pid)
    guard let raw = copyAttribute(app, kAXMenuBarAttribute as String), CFGetTypeID(raw) == AXUIElementGetTypeID()
    else { fail("action_not_permitted", "TextEdit did not expose its Save command.") }
    let menuBar = raw as! AXUIElement
    let save = children(of: menuBar).flatMap(children).flatMap(children).filter { item in
        stringAttribute(item, kAXRoleAttribute as String) == "AXMenuItem" &&
        stringAttribute(item, "AXMenuItemCmdChar").lowercased() == "s" &&
        intValue(copyAttribute(item, "AXMenuItemCmdModifiers")) == 0 && boolAttribute(item, kAXEnabledAttribute as String)
    }
    guard save.count == 1, let item = save.first, focusedDocument(target, window, file.url, windowId)
    else { fail("window_mismatch", "A verified Save command for the focused document is unavailable.") }
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
    else { fail("action_uncertain", "TextEdit did not acknowledge Save. Inspect the document before trying again.") }
    let deadline = Date().addingTimeInterval(2.5)
    while Date() < deadline {
        if documentHash(taskDocument(object).text) == edited { ok(["saved": true]) }
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.08))
    }
    fail("action_uncertain", "The approved file did not verify after Save. Inspect it before trying again.")
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 32_768,
      let object = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let command = object["command"] as? String
else { fail("invalid_request", "The native helper could not read the request.") }

switch command {
case "task-document-open":
    taskDocumentOpen(object)
case "task-document-read", "task-document-edit", "task-document-save":
    taskDocumentOperation(command, object)
case "permissions":
    ok(permissionMap())
case "open-settings":
    guard let kind = object["kind"] as? String, kind == "accessibility" || kind == "screen-recording" else {
        fail("invalid_request", "The settings request was not recognized.")
    }
    if kind == "accessibility" {
        let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
    } else {
        _ = CGRequestScreenCaptureAccess()
    }
    let opened = openSettings(kind)
    let result = permissionMap()
    let stillDenied = result[kind == "accessibility" ? "accessibility" : "screenRecording"] != "granted"
    ok([
        "accessibility": result["accessibility"] ?? "denied",
        "screenRecording": result["screenRecording"] ?? "denied",
        "opened": opened,
        "restartMayBeRequired": stillDenied,
    ])
case "list-apps":
    let records = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap(applicationRecord)
        .sorted { ($0["displayName"] as? String ?? "") < ($1["displayName"] as? String ?? "") }
    ok([
        "applications": Array(records.prefix(maxApps)),
        "truncated": records.count > maxApps,
    ])
case "list-windows":
    guard let target = readTarget(object) else { fail("invalid_request", "The application identity was not valid.") }
    _ = requireTarget(target)
    let axWindows = AXIsProcessTrusted() ? applicationWindows(target.pid) : []
    let records = cgWindows(pid: target.pid).compactMap { cg in
        windowRecord(cg, axWindow: matchedAxWindow(for: cg, in: axWindows))
    }
    ok(["windows": Array(records.prefix(maxWindows)), "truncated": records.count > maxWindows])
case "validate":
    guard let target = readTarget(object), let windowId = intValue(object["windowId"]), windowId > 0 else {
        fail("invalid_request", "The window identity was not valid.")
    }
    let app = requireTarget(target)
    guard let application = applicationRecord(app) else { fail("identity_mismatch", "The application identity did not match.") }
    let matched = cgWindows(pid: target.pid).filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == UInt32(windowId) }
    let axWindows = AXIsProcessTrusted() ? applicationWindows(target.pid) : []
    guard matched.count == 1, let cg = matched.first,
          let record = windowRecord(cg, axWindow: matchedAxWindow(for: cg, in: axWindows)) else {
        fail("window_not_found", "That window is no longer available.")
    }
    ok(["application": application, "window": record])
case "observe":
    guard let target = readTarget(object), let windowId = intValue(object["windowId"]), windowId > 0 else {
        fail("invalid_request", "The window identity was not valid.")
    }
    _ = requireTarget(target)
    let matched = matchWindow(pid: target.pid, windowId: windowId)
    guard let record = windowRecord(matched.cg, axWindow: matched.ax) else { fail("window_not_found", "That window is no longer available.") }
    var elements: [[String: Any]] = []
    var remaining = maxElements
    var omitted = 0
    var truncated = false
    walk(matched.ax, path: "", depth: 0, parentRole: "", remaining: &remaining, out: &elements, omitted: &omitted, truncated: &truncated)
    let axApp = AXUIElementCreateApplication(target.pid)
    var mbRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(axApp, kAXMenuBarAttribute as CFString, &mbRef) == .success,
       let mbElem = mbRef as! AXUIElement? {
        walkMenuBar(mbElem, remaining: &remaining, out: &elements, omitted: &omitted, truncated: &truncated)
    }
    ok([
        "elements": elements,
        "truncated": truncated,
        "omitted": omitted,
        "title": record["title"] as? String ?? "",
        "titleRedacted": record["titleRedacted"] as? Bool ?? false,
    ])
case "screenshot":
    guard let target = readTarget(object), let windowId = intValue(object["windowId"]), windowId > 0 else {
        fail("invalid_request", "The window identity was not valid.")
    }
    _ = requireTarget(target)
    let owned = cgWindows(pid: target.pid).contains { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == UInt32(windowId) }
    if !owned { fail("window_not_found", "That window is no longer available.") }
    ok(captureWindow(windowId))
case "press-button":
    guard let target = readTarget(object) else { fail("invalid_request", "The application identity was not valid.") }
    if let diskBundleId = plistBundleId(target.executablePath), diskBundleId != target.bundleId {
        fail("identity_mismatch", "The on-disk application bundle identity did not match.")
    }
    let appCheck = isExcludedTarget(bundleId: target.bundleId, executablePath: target.executablePath)
    if appCheck.excluded {
        fail("action_not_permitted", appCheck.reason)
    }
    guard let windowId = intValue(object["windowId"]), windowId > 0,
          let path = object["elementPath"] as? String,
          let role = object["role"] as? String,
          let identifier = object["identifier"] as? String,
          let expectedHash = object["labelHash"] as? String
    else { fail("invalid_request", "The control identity was not valid.") }
    _ = requireTarget(target)
    let matched = matchWindow(pid: target.pid, windowId: windowId)
    guard let windowRec = windowRecord(matched.cg, axWindow: matched.ax) else { fail("window_not_found", "That window is no longer available.") }
    let winCheck = isExcludedWindow(title: windowRec["title"] as? String ?? "", titleRedacted: windowRec["titleRedacted"] as? Bool ?? false)
    if winCheck.excluded {
        fail("action_not_permitted", winCheck.reason)
    }
    guard let element = elementAt(matched.ax, path: path) else { fail("element_stale", "That control is no longer at the same place.") }
    let liveRole = stringAttribute(element, kAXRoleAttribute as String)
    let liveSubrole = stringAttribute(element, kAXSubroleAttribute as String)
    let liveIdentifier = stringAttribute(element, kAXIdentifierAttribute as String)
    let liveLabel = elementLabel(element, role: liveRole, identifier: liveIdentifier)
    let liveHash = labelHash(role: liveRole, identifier: liveIdentifier, label: liveLabel.text)
    if liveRole != role || liveRole != "AXButton" || liveIdentifier != identifier || liveHash != expectedHash || !boolAttribute(element, kAXEnabledAttribute as String) {
        fail("element_stale", "That control changed. Refresh the observation and choose it again.")
    }
    let elCheck = isExcludedElement(role: liveRole, subrole: liveSubrole, identifier: liveIdentifier, label: liveLabel.text)
    if elCheck.excluded {
        fail("action_not_permitted", elCheck.reason)
    }
    if !elementSupportsPress(element) {
        fail("action_not_permitted", "The button does not support the accessibility press action.")
    }
    if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
        fail("action_not_permitted", "The button did not accept the accessibility action.")
    }
    ok(["pressed": true])
case "scroll-area":
    guard let target = readTarget(object) else { fail("invalid_request", "The application identity was not valid.") }
    if let diskBundleId = plistBundleId(target.executablePath), diskBundleId != target.bundleId {
        fail("identity_mismatch", "The on-disk application bundle identity did not match.")
    }
    let appCheck = isExcludedTarget(bundleId: target.bundleId, executablePath: target.executablePath)
    if appCheck.excluded {
        fail("action_not_permitted", appCheck.reason)
    }
    guard let windowId = intValue(object["windowId"]), windowId > 0,
          let path = object["elementPath"] as? String,
          let role = object["role"] as? String,
          let identifier = object["identifier"] as? String,
          let expectedHash = object["labelHash"] as? String,
          let direction = object["direction"] as? String,
          direction == "up" || direction == "down"
    else { fail("invalid_request", "The scroll control identity or direction was not valid.") }
    let increment = max(1, min(5, intValue(object["increment"]) ?? 1))
    _ = requireTarget(target)
    let matched = matchWindow(pid: target.pid, windowId: windowId)
    guard let windowRec = windowRecord(matched.cg, axWindow: matched.ax) else { fail("window_not_found", "That window is no longer available.") }
    let winCheck = isExcludedWindow(title: windowRec["title"] as? String ?? "", titleRedacted: windowRec["titleRedacted"] as? Bool ?? false)
    if winCheck.excluded {
        fail("action_not_permitted", winCheck.reason)
    }
    guard let element = elementAt(matched.ax, path: path) else { fail("element_stale", "That control is no longer at the same place.") }
    let liveRole = stringAttribute(element, kAXRoleAttribute as String)
    let liveSubrole = stringAttribute(element, kAXSubroleAttribute as String)
    let liveIdentifier = stringAttribute(element, kAXIdentifierAttribute as String)
    let liveLabel = elementLabel(element, role: liveRole, identifier: liveIdentifier)
    let liveHash = labelHash(role: liveRole, identifier: liveIdentifier, label: liveLabel.text)
    if liveRole != role || liveRole != "AXScrollArea" || liveIdentifier != identifier || liveHash != expectedHash {
        fail("element_stale", "That scroll area changed. Refresh the observation and choose it again.")
    }
    let elCheck = isExcludedElement(role: liveRole, subrole: liveSubrole, identifier: liveIdentifier, label: liveLabel.text)
    if elCheck.excluded {
        fail("action_not_permitted", elCheck.reason)
    }
    guard let vScrollRef = copyAttribute(element, kAXVerticalScrollBarAttribute as String) else {
        fail("action_not_permitted", "The scroll area does not have a vertical scroll bar.")
    }
    let vScroll = vScrollRef as! AXUIElement
    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(vScroll, kAXValueAttribute as CFString, &settable) != .success || !settable.boolValue {
        fail("action_not_permitted", "The scroll bar is not adjustable.")
    }
    var currentValRef: CFTypeRef?
    var minValRef: CFTypeRef?
    var maxValRef: CFTypeRef?
    AXUIElementCopyAttributeValue(vScroll, kAXValueAttribute as CFString, &currentValRef)
    AXUIElementCopyAttributeValue(vScroll, kAXMinValueAttribute as CFString, &minValRef)
    AXUIElementCopyAttributeValue(vScroll, kAXMaxValueAttribute as CFString, &maxValRef)
    let currentVal = (currentValRef as? NSNumber)?.doubleValue ?? 0.0
    let minVal = (minValRef as? NSNumber)?.doubleValue ?? 0.0
    let maxVal = (maxValRef as? NSNumber)?.doubleValue ?? 1.0
    let span = max(0.001, maxVal - minVal)
    let step = 0.1 * span * Double(increment)
    let targetVal: Double
    if direction == "down" {
        targetVal = min(maxVal, currentVal + step)
    } else {
        targetVal = max(minVal, currentVal - step)
    }
    if AXUIElementSetAttributeValue(vScroll, kAXValueAttribute as CFString, NSNumber(value: targetVal) as CFTypeRef) != .success {
        fail("action_not_permitted", "The scroll operation was not accepted.")
    }
    var finalValRef: CFTypeRef?
    AXUIElementCopyAttributeValue(vScroll, kAXValueAttribute as CFString, &finalValRef)
    let finalVal = (finalValRef as? NSNumber)?.doubleValue ?? targetVal
    ok([
        "scrolled": true,
        "direction": direction,
        "previousValue": currentVal,
        "newValue": finalVal,
    ])
case "select-tab":
    guard let target = readTarget(object) else { fail("invalid_request", "The application identity was not valid.") }
    if let diskBundleId = plistBundleId(target.executablePath), diskBundleId != target.bundleId {
        fail("identity_mismatch", "The on-disk application bundle identity did not match.")
    }
    let appCheck = isExcludedTarget(bundleId: target.bundleId, executablePath: target.executablePath)
    if appCheck.excluded {
        fail("action_not_permitted", appCheck.reason)
    }
    guard let windowId = intValue(object["windowId"]), windowId > 0,
          let path = object["elementPath"] as? String,
          let role = object["role"] as? String,
          let identifier = object["identifier"] as? String,
          let expectedHash = object["labelHash"] as? String
    else { fail("invalid_request", "The tab control identity was not valid.") }
    _ = requireTarget(target)
    let matched = matchWindow(pid: target.pid, windowId: windowId)
    guard let windowRec = windowRecord(matched.cg, axWindow: matched.ax) else { fail("window_not_found", "That window is no longer available.") }
    let winCheck = isExcludedWindow(title: windowRec["title"] as? String ?? "", titleRedacted: windowRec["titleRedacted"] as? Bool ?? false)
    if winCheck.excluded {
        fail("action_not_permitted", winCheck.reason)
    }
    guard let element = elementAt(matched.ax, path: path) else { fail("element_stale", "That control is no longer at the same place.") }
    let liveRole = stringAttribute(element, kAXRoleAttribute as String)
    let liveSubrole = stringAttribute(element, kAXSubroleAttribute as String)
    let liveIdentifier = stringAttribute(element, kAXIdentifierAttribute as String)
    let liveLabel = elementLabel(element, role: liveRole, identifier: liveIdentifier)
    let liveHash = labelHash(role: liveRole, identifier: liveIdentifier, label: liveLabel.text)
    if liveRole != role || (liveRole != "AXRadioButton" && liveRole != "AXTab") || liveIdentifier != identifier || liveHash != expectedHash || !boolAttribute(element, kAXEnabledAttribute as String) {
        fail("element_stale", "That tab changed or is disabled. Refresh the observation and choose it again.")
    }
    let parent = copyAttribute(element, kAXParentAttribute as String)
    let parentRole = parent != nil ? stringAttribute(parent as! AXUIElement, kAXRoleAttribute as String) : ""
    if parentRole != "AXTabGroup" && liveSubrole != "AXTabButton" {
        fail("action_not_permitted", "The control is not part of an identified tab group.")
    }
    let elCheck = isExcludedElement(role: liveRole, subrole: liveSubrole, identifier: liveIdentifier, label: liveLabel.text)
    if elCheck.excluded {
        fail("action_not_permitted", elCheck.reason)
    }
    if !elementSupportsPress(element) {
        fail("action_not_permitted", "The tab does not support the accessibility selection action.")
    }
    if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
        fail("action_not_permitted", "The tab did not accept the accessibility action.")
    }
    ok(["selected": true])
case "set-text":
    guard let target = readTarget(object) else { fail("invalid_request", "The application identity was not valid.") }
    if let diskBundleId = plistBundleId(target.executablePath), diskBundleId != target.bundleId {
        fail("identity_mismatch", "The on-disk application bundle identity did not match.")
    }
    let appCheck = isExcludedTarget(bundleId: target.bundleId, executablePath: target.executablePath)
    if appCheck.excluded {
        fail("action_not_permitted", appCheck.reason)
    }
    guard let windowId = intValue(object["windowId"]), windowId > 0,
          let path = object["elementPath"] as? String,
          let role = object["role"] as? String,
          let identifier = object["identifier"] as? String,
          let expectedHash = object["labelHash"] as? String,
          let text = object["text"] as? String
    else { fail("invalid_request", "The text control identity or text was not valid.") }
    if text.count > 1000 || text.utf8.count > 4096 {
        fail("action_not_permitted", "Text exceeds maximum character or byte limits.")
    }
    _ = requireTarget(target)
    let matched = matchWindow(pid: target.pid, windowId: windowId)
    guard let windowRec = windowRecord(matched.cg, axWindow: matched.ax) else { fail("window_not_found", "That window is no longer available.") }
    let winCheck = isExcludedWindow(title: windowRec["title"] as? String ?? "", titleRedacted: windowRec["titleRedacted"] as? Bool ?? false)
    if winCheck.excluded {
        fail("action_not_permitted", winCheck.reason)
    }
    guard let element = elementAt(matched.ax, path: path) else { fail("element_stale", "That control is no longer at the same place.") }
    let liveRole = stringAttribute(element, kAXRoleAttribute as String)
    let liveSubrole = stringAttribute(element, kAXSubroleAttribute as String)
    let liveIdentifier = stringAttribute(element, kAXIdentifierAttribute as String)
    let liveLabel = elementLabel(element, role: liveRole, identifier: liveIdentifier)
    let liveHash = labelHash(role: liveRole, identifier: liveIdentifier, label: liveLabel.text)
    let isControlEnabled = (liveRole == "AXTextField") ? boolAttribute(element, kAXEnabledAttribute as String) : true
    if liveRole != role || (liveRole != "AXTextField" && liveRole != "AXTextArea") || liveIdentifier != identifier || liveHash != expectedHash || !isControlEnabled {
        fail("element_stale", "That text field changed or is disabled. Refresh the observation and choose it again.")
    }
    let elCheck = isExcludedElement(role: liveRole, subrole: liveSubrole, identifier: liveIdentifier, label: liveLabel.text)
    if elCheck.excluded {
        fail("action_not_permitted", elCheck.reason)
    }
    var settable: DarwinBoolean = false
    if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) != .success || !settable.boolValue {
        fail("action_not_permitted", "The text field value is not editable.")
    }
    let isMultiline = (liveRole == "AXTextArea")
    for scalar in text.unicodeScalars {
        if scalar.value < 32 || scalar.value == 127 {
            if scalar.value == 10 && isMultiline {
                continue
            }
            if scalar.value == 10 {
                fail("action_not_permitted", "Newline is only permitted in multiline text areas.")
            }
            fail("action_not_permitted", "Text contains disallowed control characters.")
        }
    }
    if AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString) != .success {
        fail("action_not_permitted", "The text field did not accept the value.")
    }
    ok(["textSet": true, "characterCount": text.count])
case "open-menu":
    guard let target = readTarget(object) else { fail("invalid_request", "The application identity was not valid.") }
    if let diskBundleId = plistBundleId(target.executablePath), diskBundleId != target.bundleId {
        fail("identity_mismatch", "The on-disk application bundle identity did not match.")
    }
    let appCheck = isExcludedTarget(bundleId: target.bundleId, executablePath: target.executablePath)
    if appCheck.excluded {
        fail("action_not_permitted", appCheck.reason)
    }
    guard let windowId = intValue(object["windowId"]), windowId > 0,
          let path = object["elementPath"] as? String,
          let role = object["role"] as? String,
          let identifier = object["identifier"] as? String,
          let expectedHash = object["labelHash"] as? String
    else { fail("invalid_request", "The menu control identity was not valid.") }
    _ = requireTarget(target)
    let matched = matchWindow(pid: target.pid, windowId: windowId)
    guard let windowRec = windowRecord(matched.cg, axWindow: matched.ax) else { fail("window_not_found", "That window is no longer available.") }
    let winCheck = isExcludedWindow(title: windowRec["title"] as? String ?? "", titleRedacted: windowRec["titleRedacted"] as? Bool ?? false)
    if winCheck.excluded {
        fail("action_not_permitted", winCheck.reason)
    }
    guard let element = menuElementAt(pid: target.pid, path: path) else { fail("element_stale", "That menu is no longer at the same place.") }
    let liveRole = stringAttribute(element, kAXRoleAttribute as String)
    let liveSubrole = stringAttribute(element, kAXSubroleAttribute as String)
    let liveIdentifier = stringAttribute(element, kAXIdentifierAttribute as String)
    let liveLabel = elementLabel(element, role: liveRole, identifier: liveIdentifier)
    let liveHash = labelHash(role: liveRole, identifier: liveIdentifier, label: liveLabel.text)
    if liveRole != role || liveRole != "AXMenuBarItem" || liveIdentifier != identifier || liveHash != expectedHash || !boolAttribute(element, kAXEnabledAttribute as String) {
        fail("element_stale", "That menu changed or is disabled. Refresh the observation and choose it again.")
    }
    let elCheck = isExcludedElement(role: liveRole, subrole: liveSubrole, identifier: liveIdentifier, label: liveLabel.text)
    if elCheck.excluded {
        fail("action_not_permitted", elCheck.reason)
    }
    if !elementSupportsPress(element) {
        fail("action_not_permitted", "The menu does not support the accessibility open action.")
    }
    if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
        fail("action_not_permitted", "The menu did not accept the accessibility action.")
    }
    ok(["menuOpened": true])
case "select-menu-item":
    guard let target = readTarget(object) else { fail("invalid_request", "The application identity was not valid.") }
    if let diskBundleId = plistBundleId(target.executablePath), diskBundleId != target.bundleId {
        fail("identity_mismatch", "The on-disk application bundle identity did not match.")
    }
    let appCheck = isExcludedTarget(bundleId: target.bundleId, executablePath: target.executablePath)
    if appCheck.excluded {
        fail("action_not_permitted", appCheck.reason)
    }
    guard let windowId = intValue(object["windowId"]), windowId > 0,
          let path = object["elementPath"] as? String,
          let role = object["role"] as? String,
          let identifier = object["identifier"] as? String,
          let expectedHash = object["labelHash"] as? String
    else { fail("invalid_request", "The menu item identity was not valid.") }
    _ = requireTarget(target)
    let matched = matchWindow(pid: target.pid, windowId: windowId)
    guard let windowRec = windowRecord(matched.cg, axWindow: matched.ax) else { fail("window_not_found", "That window is no longer available.") }
    let winCheck = isExcludedWindow(title: windowRec["title"] as? String ?? "", titleRedacted: windowRec["titleRedacted"] as? Bool ?? false)
    if winCheck.excluded {
        fail("action_not_permitted", winCheck.reason)
    }
    guard let element = menuElementAt(pid: target.pid, path: path) else { fail("element_stale", "That menu item is no longer at the same place.") }
    let liveRole = stringAttribute(element, kAXRoleAttribute as String)
    let liveSubrole = stringAttribute(element, kAXSubroleAttribute as String)
    let liveIdentifier = stringAttribute(element, kAXIdentifierAttribute as String)
    let liveLabel = elementLabel(element, role: liveRole, identifier: liveIdentifier)
    let liveHash = labelHash(role: liveRole, identifier: liveIdentifier, label: liveLabel.text)
    if liveRole != role || liveRole != "AXMenuItem" || liveIdentifier != identifier || liveHash != expectedHash || !boolAttribute(element, kAXEnabledAttribute as String) {
        fail("element_stale", "That menu item changed or is disabled. Refresh the observation and choose it again.")
    }
    let kids = children(of: element)
    let isSubmenu = kids.contains { stringAttribute($0, kAXRoleAttribute as String) == "AXMenu" }
    if isSubmenu {
        fail("action_not_permitted", "A submenu cannot be selected as an item; choose an actionable item instead.")
    }
    if liveSubrole == "AXSeparator" || liveLabel.text.isEmpty {
        fail("action_not_permitted", "A menu separator cannot be selected.")
    }
    let elCheck = isExcludedElement(role: liveRole, subrole: liveSubrole, identifier: liveIdentifier, label: liveLabel.text)
    if elCheck.excluded {
        fail("action_not_permitted", elCheck.reason)
    }
    if !elementSupportsPress(element) {
        fail("action_not_permitted", "The menu item does not support the accessibility selection action.")
    }
    if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
        fail("action_not_permitted", "The menu item did not accept the accessibility action.")
    }
    ok(["menuItemSelected": true])
default:
    fail("invalid_request", "That native command is not available.")
}
