import Foundation
import CryptoKit
import AppKit
import Darwin

struct SetupError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
struct ReleaseAsset: Decodable {
    let name: String
    let browser_download_url: String
    let size: Int64
}
struct Release: Decodable {
    let tag_name: String
    let draft: Bool
    let prerelease: Bool
    let assets: [ReleaseAsset]
}
struct Payload: Decodable {
    let name: String
    let size: Int64
    let sha512: String
}
struct Manifest: Decodable {
    let schemaVersion: Int
    let version: String
    let payloads: [String: Payload]
}

final class Transfer: NSObject, URLSessionDownloadDelegate {
    private let destination: URL
    private let maximum: Int64
    private let progress: (Double) -> Void
    private let lock = NSLock()
    private var cancelled = false
    private var task: URLSessionDownloadTask?
    private var continuation: CheckedContinuation<URL, Error>?
    private var failure: Error?
    private var completed = false
    init(destination: URL, maximum: Int64, progress: @escaping (Double) -> Void) {
        self.destination = destination
        self.maximum = maximum
        self.progress = progress
    }
    func fetch(_ url: URL) async throws -> URL {
        guard Installer.trusted(url) else { throw SetupError(message: "Adresse de téléchargement non autorisée.") }
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForRequest = 60
                configuration.timeoutIntervalForResource = 1200
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                var request = URLRequest(url: url)
                request.setValue("FixedByDesign-Setup/1", forHTTPHeaderField: "User-Agent")
                let task = session.downloadTask(with: request)
                lock.lock()
                self.continuation = continuation
                self.task = task
                let shouldCancel = cancelled
                lock.unlock()
                task.resume()
                if shouldCancel { task.cancel() }
            }
        }, onCancel: {
            self.lock.lock()
            self.cancelled = true
            self.task?.cancel()
            self.lock.unlock()
        })
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, Installer.trusted(url) else {
            failure = SetupError(message: "GitHub a renvoyé une redirection non autorisée.")
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesWritten <= maximum, totalBytesExpectedToWrite <= maximum else {
            failure = SetupError(message: "Le téléchargement dépasse la taille annoncée.")
            downloadTask.cancel()
            return
        }
        progress(min(1, Double(totalBytesWritten) / Double(maximum)))
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            guard let response = downloadTask.response as? HTTPURLResponse, response.statusCode == 200 else {
                let status = (downloadTask.response as? HTTPURLResponse)?.statusCode
                throw SetupError(message: status == 404 ? "Aucune version disponible. Réessaie plus tard." : status == 403 || status == 429 ? "GitHub limite les téléchargements. Patiente puis réessaie." : "GitHub est indisponible. Vérifie ta connexion puis réessaie.")
            }
            let size = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= maximum else { throw SetupError(message: "Téléchargement trop volumineux.") }
            try FileManager.default.moveItem(at: location, to: destination)
            completed = true
        } catch { failure = error }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        session.finishTasksAndInvalidate()
        if let error = failure ?? error { continuation?.resume(throwing: error) }
        else if completed { continuation?.resume(returning: destination) }
        else { continuation?.resume(throwing: SetupError(message: "Téléchargement incomplet.")) }
        continuation = nil
    }
}

enum Installer {
    static let repository = "https://github.com/Fixed-By-Design/launcher"
    static let latest = URL(string: "https://api.github.com/repos/Fixed-By-Design/launcher/releases/latest")!
    static let bundleID = "com.fixedbydesign.launcher"
    static func trusted(_ url: URL) -> Bool {
        url.scheme == "https" && (url.port == nil || url.port == 443) && url.user == nil && url.password == nil &&
        ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"].contains(url.host ?? "")
    }
    static func architecture() throws -> String {
        var arm: Int32 = 0
        var size = MemoryLayout<Int32>.size
        if sysctlbyname("hw.optional.arm64", &arm, &size, nil, 0) == 0 && arm == 1 { return "arm64" }
        var system = utsname()
        uname(&system)
        let machine = withUnsafePointer(to: &system.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) }
        }
        guard machine == "x86_64" else { throw SetupError(message: "Ce Mac n’est pas compatible avec les versions disponibles.") }
        return "x64"
    }
    static func asset(_ release: Release, _ name: String) throws -> ReleaseAsset {
        let matches = release.assets.filter { $0.name == name }
        let expected = repository + "/releases/download/" + release.tag_name + "/" + name
        guard matches.count == 1, matches[0].browser_download_url == expected else {
            throw SetupError(message: "La release est incomplète ou contient une adresse non autorisée.")
        }
        return matches[0]
    }
    static func select(_ release: Release, _ manifest: Manifest, _ architecture: String) throws -> Payload {
        guard !release.draft, !release.prerelease, release.tag_name.range(of: #"\Av[0-9]+\.[0-9]+\.[0-9]+\z"#, options: .regularExpression) != nil,
              manifest.schemaVersion == 1, "v" + manifest.version == release.tag_name, ["arm64", "x64"].contains(architecture) else {
            throw SetupError(message: "Le manifeste ne correspond pas au canal ou à ce Mac. Télécharge à nouveau l’installateur depuis GitHub.")
        }
        guard let payload = manifest.payloads["macos-" + architecture],
              payload.name == "FBD-Launcher-" + manifest.version + "-macos-" + architecture + ".dmg",
              payload.size > 0, payload.size <= 1024 * 1024 * 1024,
              payload.sha512.range(of: #"\A[a-f0-9]{128}\z"#, options: .regularExpression) != nil,
              try asset(release, payload.name).size == payload.size else {
            throw SetupError(message: "Le fichier macOS est invalide ou absent.")
        }
        return payload
    }
    static func metadata<T: Decodable>(_ url: URL, directory: URL) async throws -> T {
        let path = directory.appendingPathComponent(UUID().uuidString + ".json")
        _ = try await Transfer(destination: path, maximum: 1024 * 1024, progress: { _ in }).fetch(url)
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: path))
    }
    static func resolve(directory: URL) async throws -> (Release, Payload, String) {
        let release: Release = try await metadata(latest, directory: directory)
        guard !release.draft, !release.prerelease, release.tag_name.range(of: #"\Av[0-9]+\.[0-9]+\.[0-9]+\z"#, options: .regularExpression) != nil else {
            throw SetupError(message: "Aucune release compatible disponible.")
        }
        let manifestAsset = try asset(release, "launcher-manifest.json")
        guard let url = URL(string: manifestAsset.browser_download_url) else { throw SetupError(message: "Adresse de manifeste invalide.") }
        let manifest: Manifest = try await metadata(url, directory: directory)
        return (release, try select(release, manifest, architecture()), manifest.version)
    }
    static func verify(_ file: URL, payload: Payload) throws {
        let input = try FileHandle(forReadingFrom: file)
        defer { try? input.close() }
        var hash = SHA512()
        var size: Int64 = 0
        while let data = try input.read(upToCount: 65536), !data.isEmpty {
            try Task.checkCancellation()
            size += Int64(data.count)
            guard size <= payload.size else { throw SetupError(message: "Le téléchargement dépasse la taille annoncée.") }
            hash.update(data: data)
        }
        let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
        guard size == payload.size, actual == payload.sha512 else { throw SetupError(message: "Le téléchargement est incomplet ou corrompu. Réessaie.") }
    }
    static func command(_ executable: String, _ arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw SetupError(message: "macOS n’a pas pu terminer la vérification ou l’installation (\(URL(fileURLWithPath: executable).lastPathComponent), code \(process.terminationStatus)).") }
    }
    static func markInternet(_ path: URL) throws {
        let value = "0081;\(String(Int(Date().timeIntervalSince1970), radix: 16));FixedByDesignSetup;\(UUID().uuidString)"
        let result = value.withCString { setxattr(path.path, "com.apple.quarantine", $0, strlen($0), 0, 0) }
        guard result == 0 else { throw SetupError(message: "Impossible de conserver la provenance Internet du téléchargement.") }
    }
    static func replace(_ staged: URL, destination: URL) throws {
        let exists = FileManager.default.fileExists(atPath: destination.path)
        let result = exists ? renamex_np(staged.path, destination.path, UInt32(RENAME_SWAP)) : rename(staged.path, destination.path)
        guard result == 0 else { throw SetupError(message: "Impossible de remplacer l’application. La version existante est conservée.") }
    }
    static func install(_ image: URL, version: String, directory: URL, applications: URL? = nil) throws -> URL {
        let files = FileManager.default
        let applications = applications ?? files.homeDirectoryForCurrentUser.appendingPathComponent("Applications", isDirectory: true)
        try files.createDirectory(at: applications, withIntermediateDirectories: true)
        let destination = applications.appendingPathComponent("Fixed By Design.app", isDirectory: true)
        if files.fileExists(atPath: destination.path) {
            guard !((try destination.resourceValues(forKeys: [.isSymbolicLinkKey])).isSymbolicLink ?? false),
                  Bundle(url: destination)?.bundleIdentifier == bundleID else {
                throw SetupError(message: "Un autre fichier occupe déjà ~/Applications/Fixed By Design.app. Il n’a pas été modifié.")
            }
        }
        guard NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).isEmpty else {
            throw SetupError(message: "Ferme Fixed By Design et Minecraft, puis réessaie.")
        }
        let mount = directory.appendingPathComponent("image", isDirectory: true)
        try files.createDirectory(at: mount, withIntermediateDirectories: true)
        try command("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount.path, image.path])
        var mounted = true
        let staging = applications.appendingPathComponent(".fbd-setup-" + UUID().uuidString, isDirectory: true)
        do {
            let source = mount.appendingPathComponent("Fixed By Design.app", isDirectory: true)
            guard Bundle(url: source)?.bundleIdentifier == bundleID,
                  Bundle(url: source)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == version else {
                throw SetupError(message: "L’application de cette image ne correspond pas à la version annoncée.")
            }
            if let minimum = Bundle(url: source)?.object(forInfoDictionaryKey: "LSMinimumSystemVersion") as? String {
                let components = minimum.split(separator: ".").compactMap { Int($0) }
                guard components.count >= 2, components.count <= 3,
                      ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: components[0], minorVersion: components[1], patchVersion: components.count == 3 ? components[2] : 0)) else {
                    throw SetupError(message: "Cette version du launcher nécessite macOS \(minimum) ou ultérieur. Ton installation existante est conservée.")
                }
            }
            try command("/usr/bin/codesign", ["--verify", "--deep", "--strict", source.path])
            try files.createDirectory(at: staging, withIntermediateDirectories: false)
            let staged = staging.appendingPathComponent("Fixed By Design.app", isDirectory: true)
            try files.copyItem(at: source, to: staged)
            try command("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged.path])
            try markInternet(staged)
            try Task.checkCancellation()
            try command("/usr/bin/hdiutil", ["detach", mount.path])
            mounted = false
            try replace(staged, destination: destination)
            try files.removeItem(at: staging)
            return destination
        } catch {
            var cleanup = ""
            if mounted {
                do { try command("/usr/bin/hdiutil", ["detach", mount.path]) }
                catch { cleanup += " L’image reste montée : \(mount.path)." }
            }
            if files.fileExists(atPath: staging.path) {
                do { try files.removeItem(at: staging) }
                catch { cleanup += " Le dossier temporaire reste présent : \(staging.path)." }
            }
            throw SetupError(message: error.localizedDescription + cleanup)
        }
    }
}
