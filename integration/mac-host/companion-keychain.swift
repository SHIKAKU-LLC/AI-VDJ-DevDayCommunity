import Foundation
import Security
import CryptoKit

// Native helper: the signing value is never an argument, stdout or a file.
// Only an exact local Keychain item is used, after native policy/consent checks.
let service = "AI VDJ Companion Registration"
let account = "owner-companion-v1"
struct Registration: Codable {
    let version: String
    let workerId: String
    var roomIds: [String]
    let approvedAtMs: Int64
    let signingValue: Data
}
enum Hold: Error { case held }
func query() -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service, kSecAttrAccount as String: account]
}
func read() throws -> Registration? {
    var q = query(); q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data, data.count <= 8192 else { throw Hold.held }
    let record = try JSONDecoder().decode(Registration.self, from: data)
    guard record.version == account, record.roomIds.count <= 8,
          record.signingValue.count == 32 else { throw Hold.held }
    return record
}
func store(_ record: Registration, existing: Bool) throws {
    let bytes = try JSONEncoder().encode(record)
    let status: OSStatus
    if existing { status = SecItemUpdate(query() as CFDictionary, [kSecValueData as String: bytes] as CFDictionary) }
    else {
        var q = query(); q[kSecValueData as String] = bytes
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        q[kSecAttrSynchronizable as String] = false
        status = SecItemAdd(q as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw Hold.held }
}
func b64(_ bytes: Data) -> String {
    bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
func publicRecord(_ record: Registration) throws -> [String: Any] {
    let signing = try Curve25519.Signing.PrivateKey(rawRepresentation: record.signingValue)
    return ["workerId":record.workerId,"roomIds":record.roomIds,"approvedAtMs":record.approvedAtMs,
            "approved":true,"revoked":false,"publicJwk":["key_ops":["verify"],"ext":true,"alg":"Ed25519",
                "kty":"OKP","x":b64(signing.publicKey.rawRepresentation),"crv":"Ed25519"]]
}
do {
    guard CommandLine.arguments.count == 2,
          ["read","enroll","sign","remove"].contains(CommandLine.arguments[1]) else { throw Hold.held }
    var bytes = Data()
    while true {
        let chunk = FileHandle.standardInput.readData(ofLength:min(1024,4097-bytes.count))
        if chunk.isEmpty { break }
        bytes.append(chunk);guard bytes.count <= 4096 else { throw Hold.held }
    }
    guard bytes.count <= 4096,
          let input = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let room = input["roomId"] as? String, UUID(uuidString:room) != nil else { throw Hold.held }
    let action = CommandLine.arguments[1]
    guard Set(input.keys) == Set(action == "sign" ? ["roomId","payload"] : ["roomId"]) else { throw Hold.held }
    var record = try read()
    var result: [String: Any]
    if action == "enroll" {
        if record == nil {
            let signing = Curve25519.Signing.PrivateKey()
            record = Registration(version:account,workerId:"device-"+UUID().uuidString.lowercased(),roomIds:[room],
                approvedAtMs:Int64(Date().timeIntervalSince1970*1000),signingValue:signing.rawRepresentation)
            try store(record!,existing:false)
        } else if !record!.roomIds.contains(room) {
            guard record!.roomIds.count < 8 else { throw Hold.held }
            record!.roomIds.append(room);try store(record!,existing:true)
        }
        result = try publicRecord(record!)
    } else if action == "read" {
        result = record?.roomIds.contains(room) == true ? try publicRecord(record!) : ["registered":false]
    } else {
        guard var value = record, value.roomIds.contains(room) else { throw Hold.held }
        if action == "sign" {
            guard let encoded = input["payload"] as? String, let payload = Data(base64Encoded:encoded),
                  payload.count <= 2048,
                  let proof = try JSONSerialization.jsonObject(with:payload) as? [String:Any],
                  (proof["path"] as? String)?.hasPrefix("/api/rooms/"+room+"/runtime/") == true,
                  proof["workerId"] as? String == value.workerId else { throw Hold.held }
            let signing = try Curve25519.Signing.PrivateKey(rawRepresentation:value.signingValue)
            result = ["signature":b64(try signing.signature(for:payload))]
        } else {
            value.roomIds.removeAll { $0 == room }
            if value.roomIds.isEmpty {
                guard SecItemDelete(query() as CFDictionary) == errSecSuccess else { throw Hold.held }
            } else { try store(value,existing:true) }
            result = ["removed":true]
        }
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]))
} catch {
    // No system error, Keychain record, payload or credential is serialized.
    FileHandle.standardError.write(Data("COMPANION_REGISTRATION_HOLD\n".utf8));exit(1)
}
