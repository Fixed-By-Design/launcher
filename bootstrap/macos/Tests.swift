import Foundation
import CryptoKit
import Darwin

@main struct BootstrapTests {
    static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw SetupError(message: message) }
    }
    static func rejects(_ action: () throws -> Void) throws {
        do { try action() } catch { return }
        throw SetupError(message: "Expected rejection")
    }
    static func main() async throws {
        let files = FileManager.default
        let directory = files.temporaryDirectory.appendingPathComponent("fbd-bootstrap-test-" + UUID().uuidString)
        try files.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? files.removeItem(at: directory) }
        if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--install" {
            let image = URL(fileURLWithPath: CommandLine.arguments[2])
            let destination = try Installer.install(image, version: CommandLine.arguments[3], directory: directory, applications: directory.appendingPathComponent("Applications"))
            try check(Bundle(url: destination)?.bundleIdentifier == Installer.bundleID, "Installed bundle is not the launcher")
            let first = try Data(contentsOf: destination.appendingPathComponent("Contents/Resources/app.asar"))
            let second = try Installer.install(image, version: CommandLine.arguments[3], directory: directory, applications: directory.appendingPathComponent("Applications"))
            try check(try Data(contentsOf: second.appendingPathComponent("Contents/Resources/app.asar")) == first, "Replacement changed the payload")
            try check(getxattr(second.path, "com.apple.quarantine", nil, 0, 0, 0) > 0, "Installed app lost Internet provenance")
            print("Native macOS installation and atomic replacement smoke checks passed; no app or game launched.")
            return
        }
        let bytes = Data("future payload".utf8)
        let hash = SHA512.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        let architecture = try Installer.architecture()
        try check(["arm64", "x64"].contains(architecture), "Native architecture unresolved")
        for architecture in ["arm64", "x64"] {
            let name = "FBD-Launcher-9.8.7-macos-\(architecture).dmg"
            let asset = ReleaseAsset(name: name, browser_download_url: Installer.repository + "/releases/download/v9.8.7/" + name, size: Int64(bytes.count))
            let release = Release(tag_name: "v9.8.7", draft: false, prerelease: false, assets: [asset])
            let payload = Payload(name: name, size: Int64(bytes.count), sha512: hash)
            let manifest = Manifest(schemaVersion: 1, version: "9.8.7", payloads: ["macos-" + architecture: payload])
            try check(try Installer.select(release, manifest, architecture).name == name, "Future release not selected")
            try rejects { _ = try Installer.select(release, manifest, "unknown") }
            try rejects { _ = try Installer.select(release, Manifest(schemaVersion: 2, version: "9.8.7", payloads: manifest.payloads), architecture) }
            try rejects { _ = try Installer.select(release, Manifest(schemaVersion: 1, version: "0.1.0", payloads: manifest.payloads), architecture) }
            try rejects { _ = try Installer.select(Release(tag_name: "v9.8.7", draft: false, prerelease: true, assets: [asset]), manifest, architecture) }
            try rejects { _ = try Installer.select(Release(tag_name: "v9.8.7", draft: true, prerelease: false, assets: [asset]), manifest, architecture) }
            try rejects { _ = try Installer.asset(Release(tag_name: "v9.8.7", draft: false, prerelease: false, assets: [asset, asset]), name) }
            let file = directory.appendingPathComponent(name)
            try bytes.write(to: file)
            try Installer.verify(file, payload: payload)
            try rejects { try Installer.verify(file, payload: Payload(name: name, size: payload.size + 1, sha512: hash)) }
            try rejects { try Installer.verify(file, payload: Payload(name: name, size: payload.size, sha512: String(repeating: "0", count: 128))) }
            try check(try Data(contentsOf: file) == bytes, "Verification changed the downloaded file")
        }
        for value in ["http://github.com/file", "https://github.com.evil.test/file", "https://user@github.com/file", "https://github.com:123/file"] {
            try check(!Installer.trusted(URL(string: value)!), "Untrusted URL accepted")
        }
        let staged = directory.appendingPathComponent("staged")
        let destination = directory.appendingPathComponent("installed")
        try files.createDirectory(at: staged, withIntermediateDirectories: false)
        try files.createDirectory(at: destination, withIntermediateDirectories: false)
        try Data("new".utf8).write(to: staged.appendingPathComponent("version"))
        try Data("old".utf8).write(to: destination.appendingPathComponent("version"))
        try Installer.replace(staged, destination: destination)
        try check(try String(contentsOf: destination.appendingPathComponent("version"), encoding: .utf8) == "new", "New app not installed")
        try check(try String(contentsOf: staged.appendingPathComponent("version"), encoding: .utf8) == "old", "Previous app not atomically retained")
        try rejects { try Installer.replace(directory.appendingPathComponent("missing"), destination: destination) }
        try check(try String(contentsOf: destination.appendingPathComponent("version"), encoding: .utf8) == "new", "Failed replacement damaged installation")
        let cancelled = Task {
            while !Task.isCancelled { await Task.yield() }
            try Installer.verify(directory.appendingPathComponent("FBD-Launcher-9.8.7-macos-arm64.dmg"), payload: Payload(name: "", size: Int64(bytes.count), sha512: hash))
        }
        cancelled.cancel()
        do { try await cancelled.value; throw SetupError(message: "Cancellation was ignored") }
        catch is CancellationError {}
        print("macOS bootstrap checks passed: future release selection, architecture, origin, size/hash, cancellation and atomic preservation.")
    }
}
