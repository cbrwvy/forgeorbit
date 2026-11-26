import AppKit
import CryptoKit
import Darwin
import Foundation
import LocalAuthentication
import Security

let schema = "forgeorbit-owner-trust-v1"
let productionBundle = "app.forgeorbit"
let qaBundle = "app.forgeorbit.qa"
let helperRelative = "Contents/Resources/app/bin/forgeorbit-owner-trust"

struct Args {
  var command = ""
  var operation = ""
  var digest = ""
  var nonce = ""
  var enrollment = ""
  var application = ""
  var locale = "en"
  var rotateKey = false
  var dataDir = ""
}

struct Caller {
  var bundleId: String
  var team: String?
  var adhoc: Bool
  var root: String
  var certSha256: String?
  var anchorSha256: String?
}

func parseArgs() -> Args {
  var args = Args()
  let argv = CommandLine.arguments
  if argv.count > 1 { args.command = argv[1] }
  var index = 2
  while index < argv.count {
    let flag = argv[index]
    let value = index + 1 < argv.count ? argv[index + 1] : ""
    switch flag {
    case "--operation": args.operation = value; index += 2
    case "--digest": args.digest = value; index += 2
    case "--nonce": args.nonce = value; index += 2
    case "--enrollment": args.enrollment = value; index += 2
    case "--application": args.application = value; index += 2
    case "--locale": args.locale = value == "ru" ? "ru" : "en"; index += 2
    case "--data-dir": args.dataDir = value; index += 2
    case "--rotate-key": args.rotateKey = true; index += 1
    default: index += 1
    }
  }
  return args
}

func jsonString(_ value: String) -> String {
  var out = "\""
  for scalar in value.unicodeScalars {
    switch scalar.value {
    case 0x22: out += "\\\""
    case 0x5C: out += "\\\\"
    case 0x0A: out += "\\n"
    case 0x0D: out += "\\r"
    case 0x09: out += "\\t"
    case 0..<0x20: out += String(format: "\\u%04x", scalar.value)
    default: out += String(scalar)
    }
  }
  return out + "\""
}

func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func fail(_ code: String, _ status: Int32) -> Never {
  let body = "{\"decision\":\"refused\",\"code\":\(jsonString(code)),\"signature\":null}\n"
  FileHandle.standardOutput.write(body.data(using: .utf8)!)
  exit(status)
}

func procPath(_ pid: pid_t) -> String? {
  var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
  if length <= 0 { return nil }
  return String(cString: buffer)
}

func bundleRoot(from start: String) -> String? {
  var url = URL(fileURLWithPath: start).resolvingSymlinksInPath()
  for _ in 0..<10 {
    if url.pathExtension == "app" { return url.path }
    let parent = url.deletingLastPathComponent()
    if parent.path == url.path { return nil }
    url = parent
  }
  return nil
}

func plistBundleId(_ root: String) -> String? {
  guard let data = FileManager.default.contents(atPath: root + "/Contents/Info.plist"),
        let object = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
        let bundleId = object["CFBundleIdentifier"] as? String else { return nil }
  return bundleId
}

struct CodeInfo {
  var identifier: String?
  var team: String?
  var adhoc: Bool
  var signed: Bool
  var certSha256: String?
  var certSha1: String?
}

func isHex64(_ text: String) -> Bool {
  guard text.count == 64 else { return false }
  return text.allSatisfy { ($0 >= "0" && $0 <= "9") || ($0 >= "a" && $0 <= "f") }
}

func codeInfo(at path: String) -> CodeInfo {
  let empty = CodeInfo(identifier: nil, team: nil, adhoc: false, signed: false, certSha256: nil, certSha1: nil)
  var code: SecStaticCode?
  let url = URL(fileURLWithPath: path) as CFURL
  guard SecStaticCodeCreateWithPath(url, [], &code) == errSecSuccess, let code else { return empty }
  var info: CFDictionary?
  guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
        let dict = info as? [String: Any] else { return empty }
  let identifier = dict[kSecCodeInfoIdentifier as String] as? String
  let team = dict[kSecCodeInfoTeamIdentifier as String] as? String
  let flags = (dict[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
  let adhoc = (flags & 0x0002) != 0
  var certSha256: String?
  var certSha1: String?
  if let certs = dict[kSecCodeInfoCertificates as String] as? [SecCertificate], let leaf = certs.first {
    let data = SecCertificateCopyData(leaf) as Data
    certSha256 = sha256Hex(data)
    certSha1 = Insecure.SHA1.hash(data: data).map { String(format: "%02X", $0) }.joined()
  }
  let signed = identifier != nil && (adhoc || certSha256 != nil)
  return CodeInfo(identifier: identifier, team: team, adhoc: adhoc, signed: signed, certSha256: certSha256, certSha1: certSha1)
}

func anchorSha256() -> String? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "app.forgeorbit.local-owner-anchor",
    kSecAttrAccount as String: "certificate-sha256",
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]
  var item: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
        isHex64(text) else { return nil }
  return text
}

// Structural validation only: it checks the signature and the bundle seal
// without evaluating certificate trust. The certificate pin is enforced
// separately (parent/helper/anchor SHA-256), and the signing identifier is
// compared explicitly. A SecRequirement would additionally consult the
// keychain search list for the (untrusted, self-signed) certificate chain,
// which made the helper depend on the user's search list and stall when the
// chain was not resolvable.
func structurallyValid(path: String) -> Bool {
  var code: SecStaticCode?
  guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess, let code else { return false }
  return SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess
}

func selfPath() -> String? { procPath(getpid()) }

func validateCaller() -> Caller {
  if getenv("DYLD_INSERT_LIBRARIES") != nil || getenv("DYLD_LIBRARY_PATH") != nil {
    fail("helper-environment-rejected", 2)
  }
  guard let parentPath = procPath(getppid()), let root = bundleRoot(from: parentPath), let bundleId = plistBundleId(root) else {
    fail("caller-identity-rejected", 3)
  }
  if bundleId != productionBundle && bundleId != qaBundle { fail("caller-identity-rejected", 3) }
  guard let helper = selfPath() else { fail("helper-path-rejected", 3) }
  let helperReal = URL(fileURLWithPath: helper).resolvingSymlinksInPath().path
  let expected = URL(fileURLWithPath: root).appendingPathComponent(helperRelative).resolvingSymlinksInPath().path
  if helperReal != expected { fail("helper-path-rejected", 3) }
  let parent = codeInfo(at: root)
  let own = codeInfo(at: helperReal)
  let expectedId = bundleId + ".owner-trust"
  if own.identifier != expectedId { fail("helper-identity-mismatch", 3) }
  if parent.team != own.team { fail("helper-team-mismatch", 3) }
  if parent.adhoc != own.adhoc { fail("helper-identity-mismatch", 3) }
  if !parent.adhoc && !own.adhoc && (parent.certSha256 == nil || parent.certSha256 != own.certSha256) {
    fail("helper-identity-mismatch", 3)
  }
  var anchor: String? = nil
  if bundleId == productionBundle {
    anchor = anchorSha256()
    if parent.adhoc || own.adhoc || parent.certSha256 == nil || anchor == nil || parent.certSha256 != anchor {
      fail("application-identity-unestablished", 4)
    }
    if parent.identifier != bundleId { fail("application-identity-unestablished", 4) }
    if !structurallyValid(path: root) { fail("application-identity-unestablished", 4) }
    if !structurallyValid(path: helperReal) { fail("helper-identity-mismatch", 3) }
  }
  return Caller(bundleId: bundleId, team: parent.team, adhoc: parent.adhoc, root: root, certSha256: parent.certSha256, anchorSha256: anchor)
}

func loadOperation(_ path: String, claimedDigest: String) -> [String: Any] {
  guard !path.isEmpty, let data = FileManager.default.contents(atPath: path) else { fail("owner-proof-invalid", 2) }
  let digest = sha256Hex(data)
  if digest != claimedDigest { fail("owner-operation-mismatch", 2) }
  guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { fail("owner-proof-invalid", 2) }
  return object
}

func displayValue(_ value: Any) -> String {
  if let number = value as? NSNumber {
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }
    return number.stringValue
  }
  return String(describing: value)
}

func label(_ key: String, _ locale: String) -> String {
  let en = [
    "projectPath": "Project", "taskId": "Task", "attemptId": "Prepared attempt", "requestId": "Request", "missionId": "Mission", "missionRevision": "Mission revision",
    "providerId": "Provider", "modelId": "Model", "accountId": "Registered account", "role": "Employee role",
    "mode": "Execution mode", "workspace": "Workspace", "filesystem": "Filesystem", "terminalAllowed": "Terminal",
    "browserAllowed": "Browser", "computerUseAllowed": "Native Computer Use", "gitRead": "Git read",
    "gitPublish": "Git publish", "deploymentAllowed": "Deployment", "scope": "Scope", "expiresAt": "Expires",
    "knownCost": "Known API cost", "costCoverage": "Subscription consumption", "externalProcess": "Real external provider process starts",
    "cancellationAvailable": "Cancellation available",
  ]
  let ru = [
    "projectPath": "Проект", "taskId": "Задача", "attemptId": "Подготовленная попытка", "requestId": "Запрос", "missionId": "Миссия", "missionRevision": "Ревизия миссии",
    "providerId": "Провайдер", "modelId": "Модель", "accountId": "Зарегистрированный аккаунт", "role": "Роль сотрудника",
    "mode": "Режим исполнения", "workspace": "Рабочая папка", "filesystem": "Файловая система", "terminalAllowed": "Терминал",
    "browserAllowed": "Браузер", "computerUseAllowed": "Нативное управление компьютером", "gitRead": "Чтение Git",
    "gitPublish": "Публикация Git", "deploymentAllowed": "Развёртывание", "scope": "Область", "expiresAt": "Истекает",
    "knownCost": "Известная стоимость API", "costCoverage": "Расход подписки", "externalProcess": "Реальный внешний процесс провайдера запускается",
    "cancellationAvailable": "Отмена доступна",
  ]
  return (locale == "ru" ? ru : en)[key] ?? key
}

func displayLines(_ operation: [String: Any], _ locale: String) -> String {
  let fields = [
    "projectPath", "taskId", "attemptId", "requestId", "missionId", "missionRevision", "providerId", "modelId", "accountId", "role",
    "mode", "workspace", "filesystem", "terminalAllowed", "browserAllowed", "computerUseAllowed", "gitRead",
    "gitPublish", "deploymentAllowed", "scope", "expiresAt", "knownCost", "costCoverage", "externalProcess",
    "cancellationAvailable",
  ]
  return fields.compactMap { key in
    let value = operation[key].map { displayValue($0) } ?? ""
    if key == "attemptId" && (value.isEmpty || value == "none") { return nil }
    return "\(label(key, locale)): \(value)"
  }.joined(separator: "\n")
}

func payloadCanonical(operation: [String: Any], application: String, enrollment: String, nonce: String, digest: String, issuedAt: Int) -> String {
  let expires = operation["expiresAt"] as? Int ?? (operation["expiresAt"] as? NSNumber)?.intValue ?? 0
  let fields = [
    ("applicationIdentity", jsonString(application)),
    ("challenge", jsonString(nonce)),
    ("enrollmentId", jsonString(enrollment)),
    ("expiresAt", String(expires)),
    ("issuedAt", String(issuedAt)),
    ("missionStateDigest", jsonString(String(describing: operation["missionStateDigest"] ?? ""))),
    ("operationDigest", jsonString(digest)),
    ("policyRevision", jsonString(String(describing: operation["policyRevision"] ?? ""))),
    ("schema", jsonString(schema)),
    ("scope", jsonString(String(describing: operation["scope"] ?? ""))),
    ("taskStateDigest", jsonString(String(describing: operation["taskStateDigest"] ?? ""))),
  ]
  return "{" + fields.map { "\(jsonString($0.0)):\($0.1)" }.joined(separator: ",") + "}"
}

func base64url(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

func p1363(from der: Data) -> Data? {
  if der.count == 64 { return der }
  var index = 0
  func byte() -> UInt8? { guard index < der.count else { return nil }; let value = der[index]; index += 1; return value }
  guard byte() == 0x30, let sequence = byte(), sequence & 0x80 == 0 else { return nil }
  func integer() -> Data? {
    guard byte() == 0x02, let length = byte() else { return nil }
    guard length > 0, index + Int(length) <= der.count else { return nil }
    var part = der.subdata(in: index..<(index + Int(length)))
    index += Int(length)
    if part.first == 0x00 { part = part.dropFirst() }
    if part.count == 0 || part.count > 32 { return nil }
    return Data(repeating: 0, count: 32 - part.count) + part
  }
  guard let r = integer(), let s = integer(), index == der.count else { return nil }
  return r + s
}

func spki(from raw: Data) -> Data? {
  guard raw.count == 65, raw.first == 0x04 else { return nil }
  let prefix = Data([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08,
    0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ])
  return prefix + raw
}

func accessControl() -> SecAccessControl? {
  SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], nil)
}

/**
 * Secure Enclave key storage.
 *
 * A self-signed app cannot use the data-protection keychain, so a keychain
 * item with kSecAttrAccessControl fails with errSecMissingEntitlement
 * (-34018). CryptoKit can still create a Secure Enclave P-256 key without any
 * Apple entitlement; its `dataRepresentation` is an SE-encrypted blob, not the
 * private key. The blob is stored in the app profile at 0600 and is usable only
 * on this Mac with user presence. It is not exported anywhere.
 */
func ownerKeyPath(_ dataDir: String) -> String {
  (dataDir as NSString).appendingPathComponent("owner-trust/owner-se-key.bin")
}

func writeOwnerKey(_ blob: Data, _ dataDir: String) -> Bool {
  guard !dataDir.isEmpty, dataDir.hasPrefix("/") else { return false }
  let file = ownerKeyPath(dataDir)
  let dir = (file as NSString).deletingLastPathComponent
  do {
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try blob.write(to: URL(fileURLWithPath: file), options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file)
    return true
  } catch {
    return false
  }
}

func readOwnerKey(_ dataDir: String) -> Data? {
  guard !dataDir.isEmpty, dataDir.hasPrefix("/") else { return nil }
  return FileManager.default.contents(atPath: ownerKeyPath(dataDir))
}

func deleteStoredKey(_ dataDir: String) {
  guard !dataDir.isEmpty, dataDir.hasPrefix("/") else { return }
  try? FileManager.default.removeItem(atPath: ownerKeyPath(dataDir))
}

func createOwnerKey(_ dataDir: String, _ context: LAContext) -> SecureEnclave.P256.Signing.PrivateKey? {
  guard let control = accessControl() else { return nil }
  do {
    let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: control, authenticationContext: context)
    guard writeOwnerKey(key.dataRepresentation, dataDir) else { return nil }
    return key
  } catch {
    return nil
  }
}

func existingOwnerKey(_ dataDir: String, _ context: LAContext) -> SecureEnclave.P256.Signing.PrivateKey? {
  guard let blob = readOwnerKey(dataDir) else { return nil }
  return try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
}

func publicSpki(_ key: SecureEnclave.P256.Signing.PrivateKey) -> String? {
  var raw = Data([0x04])
  raw.append(key.publicKey.rawRepresentation)
  return spki(from: raw).map(base64url)
}

func sign(_ message: String, key: SecureEnclave.P256.Signing.PrivateKey) -> String? {
  guard let data = message.data(using: .utf8), let signature = try? key.signature(for: data) else { return nil }
  return base64url(signature.rawRepresentation)
}

func statusCommand() {
  let context = LAContext()
  var error: NSError?
  let can = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
  let biometry: String
  switch context.biometryType {
  case .touchID: biometry = "touchID"
  case .opticID: biometry = "opticID"
  default: biometry = "password-or-watch"
  }
  let hardware = processIsArm64()
  let body = "{\"decision\":\"status\",\"canEvaluate\":\(can ? "true" : "false"),\"authenticated\":false,\"biometry\":\(jsonString(biometry)),\"secureEnclaveHardware\":\(hardware ? "true" : "false"),\"signed\":false}\n"
  FileHandle.standardOutput.write(body.data(using: .utf8)!)
  exit(0)
}

func processIsArm64() -> Bool {
  var value: Int32 = 0
  var size = MemoryLayout<Int32>.size
  if sysctlbyname("hw.optional.arm64", &value, &size, nil, 0) == 0 { return value == 1 }
  var machine = [CChar](repeating: 0, count: 256)
  var machineSize = machine.count
  if sysctlbyname("hw.machine", &machine, &machineSize, nil, 0) == 0 {
    return String(cString: machine).hasPrefix("arm64")
  }
  return false
}

func inspectCommand(_ args: Args) {
  let operation = loadOperation(args.operation, claimedDigest: args.digest)
  let issuedAt = Int(Date().timeIntervalSince1970 * 1000)
  let payload = payloadCanonical(operation: operation, application: args.application, enrollment: args.enrollment, nonce: args.nonce, digest: args.digest, issuedAt: issuedAt)
  let body = "{\"decision\":\"inspect\",\"signed\":false,\"display\":\(jsonString(displayLines(operation, args.locale))),\"payload\":\(jsonString(payload))}\n"
  FileHandle.standardOutput.write(body.data(using: .utf8)!)
  exit(0)
}

final class Approver: NSObject, NSApplicationDelegate {
  let args: Args
  let caller: Caller
  init(_ args: Args, _ caller: Caller) { self.args = args; self.caller = caller }

  func applicationDidFinishLaunching(_ notification: Notification) {
    let operation = loadOperation(args.operation, claimedDigest: args.digest)
    if args.application.isEmpty || args.application != caller.bundleId { fail("owner-application-mismatch", 2) }
    let isRealLaunch = (operation["externalProcess"] as? Bool) == true
    let isProjectEnvelope = (operation["kind"] as? String) == "project-envelope"
    let alert = NSAlert()
    if isProjectEnvelope {
      alert.messageText = args.locale == "ru"
        ? "Авторизация ForgeOrbit: самостоятельная работа по проекту"
        : "ForgeOrbit Owner authorization: independent project work"
    } else if isRealLaunch {
      alert.messageText = args.locale == "ru"
        ? "Авторизация реального запуска провайдера ForgeOrbit"
        : "ForgeOrbit Owner launch authorization"
    } else {
      alert.messageText = args.locale == "ru"
        ? "Регистрация и предпросмотр владельца ForgeOrbit"
        : "ForgeOrbit Owner enrollment & preview"
    }
    let intro = isProjectEnvelope
      ? (args.locale == "ru"
        ? "Аутентификация macOS разрешает ForgeOrbit запускать реальных ИИ-агентов (разработчика и независимого ревьюера) для этого проекта в пределах указанных ниже правил, бюджета запусков и срока, без отдельного подтверждения на каждый запуск. Это не разрешает push, развёртывание, управление браузером или приложениями и доступ вне проекта. Отмена не создаёт разрешение и ничего не запускает."
        : "Authenticating with macOS lets ForgeOrbit start real AI agents (a Developer and an independent Reviewer) for this project within the rules, launch budget and time shown below, without a separate confirmation for each launch. It does not allow pushing, deploying, browser or app control, or access outside the project. Cancel creates no authorization and starts nothing.")
      : isRealLaunch
      ? (args.locale == "ru"
        ? "Аутентификация macOS разрешает и однократно запускает реальный внешний процесс ИИ-провайдера для этой подготовленной попытки. Отмена не создаёт разрешение и ничего не запускает."
        : "Authenticating with macOS authorizes and launches this exact real external AI provider process once for this prepared attempt. Cancel creates no grant and starts nothing.")
      : (args.locale == "ru"
        ? "Предпросмотр в настройках: реальный процесс ИИ-провайдера НЕ запустится и не получит разрешение на запуск. Отмена не создаёт разрешение."
        : "Settings enrollment / preview only: no external AI provider process will start or be authorized to launch. Cancel creates no grant.")
    alert.informativeText = intro + "\n\n" + displayLines(operation, args.locale)
    alert.addButton(withTitle: args.locale == "ru" ? "Отменить" : "Cancel")
    alert.addButton(withTitle: isProjectEnvelope
      ? (args.locale == "ru" ? "Подтвердить правила проекта" : "Authenticate project rules")
      : isRealLaunch
      ? (args.locale == "ru" ? "Подтвердить и запустить" : "Authenticate and launch")
      : (args.locale == "ru" ? "Подтвердить предпросмотр" : "Authenticate preview only"))
    alert.buttons.first?.keyEquivalent = "\u{1b}"
    NSApp.activate(ignoringOtherApps: true)
    if alert.runModal() != .alertFirstButtonReturn {
      let production = caller.bundleId == productionBundle && !caller.adhoc && caller.certSha256 != nil && caller.certSha256 == caller.anchorSha256
      if !production { fail("application-identity-unestablished", 4) }
      let context = LAContext()
      let reason = isProjectEnvelope
        ? (args.locale == "ru" ? "Авторизовать самостоятельную работу ForgeOrbit по этому проекту" : "Authorize ForgeOrbit independent work for this project")
        : isRealLaunch
        ? (args.locale == "ru"
          ? "Запустить реальный процесс \(operation["providerId"] ?? "провайдера") (\(operation["role"] ?? "операцию"))"
          : "Launch real \(operation["providerId"] ?? "provider") process (\(operation["role"] ?? "operation"))")
        : (args.locale == "ru"
          ? "Подтвердить регистрацию или предпросмотр ForgeOrbit (без запуска провайдера)"
          : "Confirm ForgeOrbit enrollment or preview (no provider launch)")
      context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
        DispatchQueue.main.async {
          if !success { fail("authentication-failed", 2) }
          guard !self.args.dataDir.isEmpty, self.args.dataDir.hasPrefix("/") else { fail("owner-se-key-storage-unavailable", 4) }
          // A new enrollment rotates the Secure Enclave key. A revoked or
          // rotated enrollment must not lock the Owner out of a fresh
          // enrollment with a replacement certificate, and a new key keeps the
          // revoked key permanently revoked.
          if self.args.rotateKey { deleteStoredKey(self.args.dataDir) }
          let existingBlob = readOwnerKey(self.args.dataDir) != nil
          let key: SecureEnclave.P256.Signing.PrivateKey?
          if existingBlob {
            key = existingOwnerKey(self.args.dataDir, context)
          } else {
            key = createOwnerKey(self.args.dataDir, context)
          }
          guard let key else { fail("secure-enclave-unavailable", 4) }
          let issuedAt = Int(Date().timeIntervalSince1970 * 1000)
          let payload = payloadCanonical(
            operation: operation,
            application: self.caller.bundleId,
            enrollment: self.args.enrollment,
            nonce: self.args.nonce,
            digest: self.args.digest,
            issuedAt: issuedAt,
          )
          guard let signature = sign(payload, key: key), let publicKey = publicSpki(key) else { fail("secure-enclave-unavailable", 4) }
          let body = "{\"schema\":\(jsonString(schema)),\"decision\":\"signed\",\"publicKeySpki\":\(jsonString(publicKey)),\"payload\":\(payload),\"signature\":\(jsonString(signature))}\n"
          FileHandle.standardOutput.write(body.data(using: .utf8)!)
          exit(0)
        }
      }
      return
    }
    fail("authentication-cancelled", 3)
  }
}

let args = parseArgs()
switch args.command {
case "status":
  statusCommand()
case "inspect":
  inspectCommand(args)
case "check-caller":
  do {
    let caller = validateCaller()
    let production = caller.bundleId == productionBundle && !caller.adhoc && caller.certSha256 != nil && caller.certSha256 == caller.anchorSha256
    let signed = caller.certSha256 != nil && !caller.adhoc
    let checked = "{\"decision\":\"caller-ok\",\"bundleId\":\(jsonString(caller.bundleId)),\"production\":\(production ? "true" : "false"),\"adhoc\":\(caller.adhoc ? "true" : "false"),\"signed\":\(signed ? "true" : "false")}\n"
    FileHandle.standardOutput.write(checked.data(using: .utf8)!)
    exit(0)
  }
case "approve", "enroll":
  do {
    let caller = validateCaller()
    let app = NSApplication.shared
    let delegate = Approver(args, caller)
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
  }
default:
  fail("owner-proof-invalid", 2)
}
