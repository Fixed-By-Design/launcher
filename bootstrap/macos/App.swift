import SwiftUI
import Foundation

@MainActor final class SetupModel: ObservableObject {
    @Published var status = "La dernière version compatible sera téléchargée depuis GitHub."
    @Published var progress = 0.0
    @Published var busy = false
    @Published var installing = false
    @Published var destination: URL?
    private var task: Task<Void, Never>?
    func cancel() { task?.cancel() }
    func start() {
        busy = true
        destination = nil
        progress = 0
        task = Task {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("fbd-setup-" + UUID().uuidString, isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
                status = "Recherche de la dernière version sur GitHub…"
                let (release, payload, version) = try await Installer.resolve(directory: directory)
                status = "Téléchargement de la version \(version)…"
                let file = directory.appendingPathComponent(payload.name)
                let asset = try Installer.asset(release, payload.name)
                guard let url = URL(string: asset.browser_download_url) else { throw SetupError(message: "Adresse de téléchargement invalide.") }
                let available = try directory.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage
                guard let available, available > payload.size * 4 else { throw SetupError(message: "Libère de l’espace disque puis réessaie (environ \(payload.size * 4 / 1048576) Mo nécessaires).") }
                _ = try await Transfer(destination: file, maximum: payload.size, progress: { value in
                    Task { @MainActor in self.progress = value }
                }).fetch(url)
                status = "Vérification du téléchargement…"
                try Installer.verify(file, payload: payload)
                try Installer.markInternet(file)
                try Task.checkCancellation()
                installing = true
                status = "Installation dans ~/Applications…"
                destination = try await Task.detached { try Installer.install(file, version: version, directory: directory) }.value
                status = "Installation terminée. macOS peut demander une autorisation ou empêcher l’ouverture de cette version non notarisée."
            } catch {
                status = Task.isCancelled ? "Téléchargement annulé. Ton installation existante n’a pas été modifiée." : "Installation impossible : " + error.localizedDescription
            }
            do { if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) } }
            catch { status += "\nNettoyage impossible : " + error.localizedDescription }
            busy = false
            installing = false
            task = nil
        }
    }
}

@MainActor final class ApplicationDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var model: SetupModel?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let model, model.busy else { return .terminateNow }
        if !model.installing { model.cancel() }
        return .terminateCancel
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let model, model.busy else { return true }
        if !model.installing { model.cancel() }
        return false
    }
}

@main struct BootstrapApp: App {
    @NSApplicationDelegateAdaptor(ApplicationDelegate.self) var delegate
    @StateObject private var model = SetupModel()
    var body: some Scene {
        WindowGroup("Installer Fixed By Design") {
            VStack(alignment: .leading, spacing: 22) {
                Text("Ton aventure commence ici.").font(.system(size: 30, weight: .medium))
                Text("Version communautaire de test, sans signature d’éditeur ni notarisation. macOS peut empêcher son ouverture.").foregroundColor(Color(red: 0.77, green: 0.81, blue: 0.72))
                Text(model.status).frame(maxWidth: .infinity, alignment: .leading).accessibilityLabel("État de l’installation")
                ProgressView(value: model.progress).accessibilityLabel("Téléchargement")
                HStack(spacing: 20) {
                    Button(model.destination == nil ? "Installer la dernière version" : "Réinstaller") { model.start() }.disabled(model.busy).keyboardShortcut(.defaultAction)
                    if model.busy { Button("Annuler") { model.cancel() }.disabled(model.installing) }
                    if let path = model.destination {
                        Button("Afficher dans le Finder") { NSWorkspace.shared.activateFileViewerSelecting([path]) }
                    }
                }
                Text("Installation dans ton dossier Applications personnel, sans mot de passe administrateur. Aucun compte n’est nécessaire pour l’installation.").font(.footnote).foregroundColor(.secondary)
            }
            .padding(30).frame(width: 540, alignment: .leading)
            .background(Color(red: 0.063, green: 0.082, blue: 0.063))
            .preferredColorScheme(.dark)
            .onAppear { delegate.model = model; NSApplication.shared.windows.first?.delegate = delegate; NSApplication.shared.activate(ignoringOtherApps: true) }
        }.windowStyle(.hiddenTitleBar)
    }
}
