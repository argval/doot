import AppKit
import SwiftUI
import UniformTypeIdentifiers

typealias JSON = [String: Any]
extension Notification.Name {
    static let dootSettingsWillHide = Notification.Name("dootSettingsWillHide")
}
private var sendToController: (@convention(c) (UnsafePointer<CChar>) -> Void)?

struct LosslessDouble: Decodable {
    let value: Double
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Double.self) { self.value = value }
        else if let value = try? container.decode(Int64.self) { self.value = Double(value) }
        else { self.value = Double(try container.decode(Int.self)) }
    }
}

struct NativeError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

@MainActor final class Bridge {
    static let shared = Bridge()
    var ready = false
    private var pending: [String: CheckedContinuation<JSON, Error>] = [:]
    func request(_ operation: String, _ args: JSON = [:]) async throws -> JSON {
        guard ready, let send = sendToController else { throw NativeError(message: "Doot is starting. Try again in a moment.") }
        let id = UUID().uuidString
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "operation": operation, "args": args])
        let text = String(decoding: data, as: UTF8.self)
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            text.withCString { send($0) }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(60))
                self?.pending.removeValue(forKey: id)?.resume(throwing: NativeError(message: "Doot did not finish this action. Check its current state before trying again."))
            }
        }
    }
    func receive(_ value: JSON) {
        if let id = value["id"] as? String, let continuation = pending.removeValue(forKey: id) {
            if value["ok"] as? Bool == true { continuation.resume(returning: value["result"] as? JSON ?? [:]) }
            else { continuation.resume(throwing: NativeError(message: value["error"] as? String ?? "The action failed.")) }
        } else if let event = value["event"] as? String {
            if event == "prefs" { SettingsModel.shared.acceptPreferences(value) }
            if event == "overlay" { OverlayModel.shared.accept(value) }
            if event == "session" {
                let state = value["state"] as? String ?? "idle"
                SettingsModel.shared.captureActive = !["idle", "error"].contains(state)
                if SettingsModel.shared.captureActive { languagePopover?.close() }
                if ["idle", "error"].contains(state), settingsWindow?.isVisible == true {
                    SettingsModel.shared.refreshHistory()
                }
            }
        }
    }
}

func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
    guard let value else { throw NativeError(message: "Doot returned incomplete data.") }
    return try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
}

struct Preferences: Codable {
    var captionFontSize: Double
    var overlayIdleOpacity: Double
    var contextHint: String
    var targetLanguage: String
    var onboardingComplete: Bool
    private enum CodingKeys: String, CodingKey {
        case captionFontSize, overlayIdleOpacity, contextHint, targetLanguage, onboardingComplete
    }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        captionFontSize = try container.decode(LosslessDouble.self, forKey: .captionFontSize).value
        overlayIdleOpacity = try container.decode(LosslessDouble.self, forKey: .overlayIdleOpacity).value
        contextHint = try container.decode(String.self, forKey: .contextHint)
        targetLanguage = try container.decode(String.self, forKey: .targetLanguage)
        onboardingComplete = try container.decode(Bool.self, forKey: .onboardingComplete)
    }
}
struct Session: Decodable, Identifiable, Hashable {
    let id: String
    let title: String?
    let sourceLanguage: String
    let targetLanguage: String
    let startedAtMs: Double
    let segmentCount: Int
    let interrupted: Bool?
    let preview: String
    var date: String { Date(timeIntervalSince1970: startedAtMs / 1000).formatted(date: .abbreviated, time: .shortened) }
    var name: String { title?.isEmpty == false ? title! : date }
    private enum CodingKeys: String, CodingKey {
        case id, title, sourceLanguage, targetLanguage, startedAtMs, segmentCount, interrupted, preview
    }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        sourceLanguage = try container.decode(String.self, forKey: .sourceLanguage)
        targetLanguage = try container.decode(String.self, forKey: .targetLanguage)
        startedAtMs = try container.decode(LosslessDouble.self, forKey: .startedAtMs).value
        segmentCount = try container.decode(Int.self, forKey: .segmentCount)
        interrupted = try container.decodeIfPresent(Bool.self, forKey: .interrupted)
        preview = try container.decode(String.self, forKey: .preview)
    }
}
struct Segment: Decodable, Identifiable {
    let id: String
    let translatedText: String
    let startMs: Double
    var time: String { String(format: "%d:%02d", Int(startMs / 60000), Int(startMs / 1000) % 60) }
    private enum CodingKeys: String, CodingKey { case id, translatedText, startMs }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        translatedText = try container.decode(String.self, forKey: .translatedText)
        startMs = try container.decode(LosslessDouble.self, forKey: .startMs).value
    }
}
struct Detail: Decodable {
    let id: String
    let title: String?
    let sourceLanguage: String
    let targetLanguage: String
    let startedAtMs: Double
    let interrupted: Bool?
    let segments: [Segment]
}
struct Policy: Decodable { var saveHistory: Bool; var retentionDays: Int }
struct StatusRow: Decodable, Identifiable { let title: String; let value: String; let ok: Bool; var id: String { title } }
enum Page: String, CaseIterable, Identifiable {
    case setup = "Setup", general = "General", captions = "Captions", history = "History", privacy = "Privacy", connection = "Connection", about = "About"
    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .setup: "key.fill"
        case .general: "gearshape.fill"
        case .captions: "captions.bubble.fill"
        case .history: "clock.fill"
        case .privacy: "hand.raised.fill"
        case .connection: "waveform.path.ecg"
        case .about: "info.circle.fill"
        }
    }
    var color: Color {
        switch self {
        case .setup: .yellow
        case .general: .gray
        case .captions: dootAccent
        case .history: .cyan
        case .privacy: .green
        case .connection: .orange
        case .about: .blue
        }
    }
    var keywords: String {
        switch self {
        case .setup: "key api sarvam gemini speechmatics openai permission audio"
        case .general: "login startup overlay position click through"
        case .captions: "opacity transparency text size font preview context names"
        case .history: "sessions transcript export"
        case .privacy: "save retention history"
        case .connection: "gateway audio permission route timing diagnostics"
        case .about: "version about doot"
        }
    }
}

@MainActor final class SettingsModel: ObservableObject {
    static let shared = SettingsModel()
    @Published var page: Page = .general
    @Published var preferences: Preferences?
    @Published var overlayPreview: OverlaySnapshot?
    @Published var keys: [String: Bool] = [:]
    @Published var openAtLogin = false
    @Published var captureActive = false
    @Published var notice = ""
    @Published var error = ""
    @Published var busy = false
    @Published var loading = false
    @Published var appName = "Doot"
    @Published var appVersion = "0.1.0"
    @Published var labels: [String: String] = [:]
    @Published var policy: Policy?
    @Published var retention = 0
    @Published var sessions: [Session] = []
    @Published var selected: String?
    @Published var detail: Detail?
    @Published var historyQuery = ""
    @Published var historyPage = 0
    @Published var hasMore = false
    @Published var historyLoading = false
    @Published var detailLoading = false
    @Published var status: [StatusRow] = []
    @Published var routeDescription = ""
    @Published var diagnostics = ""
    @Published var diagnosticsJSON = ""
    @Published var navigation: [Page] = [.general]
    @Published var navigationIndex = 0
    private var historyGeneration = 0
    private var searchTask: Task<Void, Never>?
    private var editingPreferences = false
    private var initialLoad = true

    func navigate(_ next: Page) {
        guard page != next else { return }
        navigation = Array(navigation.prefix(navigationIndex + 1)) + [next]
        navigationIndex += 1
        page = next
    }
    func go(_ direction: Int) {
        let next = navigationIndex + direction
        guard navigation.indices.contains(next) else { return }
        navigationIndex = next
        page = navigation[next]
    }
    func acceptPreferences(_ value: JSON) {
        guard !editingPreferences else { return }
        if let prefs = try? decode(Preferences.self, value["prefs"]) { preferences = prefs }
        if let overlay = try? decode(OverlaySnapshot.self, value["overlay"]) { overlayPreview = overlay }
    }
    func reload() {
        guard !loading else { return }
        loading = true
        Task {
            defer { loading = false }
            do {
                let data = try await Bridge.shared.request("settings")
                acceptPreferences(data)
                keys = data["keys"] as? [String: Bool] ?? [:]
                labels = data["labels"] as? [String: String] ?? [:]
                appName = data["name"] as? String ?? "Doot"
                appVersion = data["version"] as? String ?? "0.1.0"
                openAtLogin = data["openAtLogin"] as? Bool ?? false
                captureActive = data["captureActive"] as? Bool ?? false
                if initialLoad, preferences?.onboardingComplete == false {
                    page = .setup; navigation = [.setup]; navigationIndex = 0
                }
                initialLoad = false
                error = data["warning"] as? String ?? ""
            } catch { self.error = error.localizedDescription }
        }
    }
    func action(_ operation: String, _ args: JSON = [:], success: String = "", apply: @escaping (JSON) -> Void = { _ in }) {
        guard !busy else { return }
        busy = true; error = ""; notice = ""
        Task {
            defer { busy = false; editingPreferences = false }
            do { let result = try await Bridge.shared.request(operation, args); notice = success; apply(result) }
            catch { self.error = error.localizedDescription }
        }
    }
    func savePreference(_ patch: JSON) {
        editingPreferences = true
        error = ""
        Task {
            do {
                let result = try await Bridge.shared.request("prefs", patch)
                editingPreferences = false
                acceptPreferences(result)
            } catch {
                editingPreferences = false
                self.error = error.localizedDescription
            }
        }
    }
    func loadPolicy() {
        action("policy") { [weak self] result in
            guard let policy = try? decode(Policy.self, result) else { return }
            self?.policy = policy; self?.retention = policy.retentionDays
        }
    }
    func savePolicy(_ save: Bool, _ days: Int) {
        action("savePolicy", ["saveHistory": save, "retentionDays": days], success: "Preferences saved. Recording changes apply to the next session.") { [weak self] result in
            self?.policy = try? decode(Policy.self, result)
        }
    }
    func refreshHistory(reset: Bool = true) {
        if reset { historyPage = 0 }
        historyGeneration += 1
        let generation = historyGeneration
        let args: JSON = ["query": historyQuery, "page": historyPage]
        historyLoading = true
        Task {
            do {
                let result = try await Bridge.shared.request("history", args)
                guard generation == historyGeneration else { return }
                sessions = try decode([Session].self, result["sessions"])
                hasMore = result["hasMore"] as? Bool ?? false
                error = ""
            } catch { if generation == historyGeneration { self.error = error.localizedDescription } }
            if generation == historyGeneration { historyLoading = false }
        }
    }
    func searchHistory() {
        searchTask?.cancel()
        searchTask = Task {
            do { try await Task.sleep(for: .milliseconds(200)); refreshHistory() } catch { }
        }
    }
    func loadDetail(_ id: String?) {
        selected = id; detail = nil
        guard let id else { detailLoading = false; return }
        detailLoading = true
        Task {
            do {
                let result = try await Bridge.shared.request("detail", ["id": id])
                guard selected == id else { return }
                detail = try decode(Detail.self, result)
                error = ""
            } catch { if selected == id { self.error = error.localizedDescription } }
            if selected == id { detailLoading = false }
        }
    }
    func deleteSession(_ id: String) {
        confirm(title: "Delete this caption session?", message: "This permanently deletes the saved transcript from this computer.", action: "Delete Session") { [weak self] in
            self?.action("delete", ["id": id]) { _ in
                if self?.selected == id { self?.loadDetail(nil) }
                self?.refreshHistory()
            }
        }
    }
    func exportSession(_ id: String, _ format: String) {
        action("export", ["id": id, "format": format]) { [weak self] result in
            guard let body = result["body"] as? String, let filename = result["filename"] as? String else { return }
            saveExport(body, filename, format) { outcome in
                switch outcome {
                case .success(let saved): if saved { self?.notice = "Transcript exported." }
                case .failure(let error): self?.error = error.localizedDescription
                }
            }
        }
    }
    func copySession(_ id: String) {
        action("export", ["id": id, "format": "txt"]) { [weak self] result in
            guard let body = result["body"] as? String else { return }
            self?.copy(body, notice: "Transcript copied.")
        }
    }
    func copy(_ text: String, notice: String) {
        NSPasteboard.general.clearContents()
        if NSPasteboard.general.setString(text, forType: .string) { self.notice = notice }
        else { error = "Could not copy to the clipboard." }
    }
    func refreshConnection() async {
        do {
            let result = try await Bridge.shared.request("connection")
            status = try decode([StatusRow].self, result["rows"])
            routeDescription = result["description"] as? String ?? ""
        } catch { self.error = error.localizedDescription }
    }
    func pair(_ source: String, _ target: String) -> String {
        let from = labels[source] ?? source
        return source == target ? from : "\(from) → \(labels[target] ?? target)"
    }
}

@MainActor var settingsWindow: NSWindow?
@MainActor var languagePopover: NSPopover?
@MainActor var languageAnchor: NSView?

@MainActor private func confirm(title: String, message: String, action: String, completion: @escaping () -> Void) {
    guard let window = settingsWindow, window.attachedSheet == nil else { return }
    let alert = NSAlert()
    alert.messageText = title; alert.informativeText = message; alert.alertStyle = .warning
    alert.addButton(withTitle: "Cancel")
    let destructive = alert.addButton(withTitle: action)
    destructive.hasDestructiveAction = true
    alert.beginSheetModal(for: window) { response in if response == .alertSecondButtonReturn { completion() } }
}

@MainActor private func saveExport(_ body: String, _ filename: String, _ format: String, completion: @escaping (Result<Bool, Error>) -> Void) {
    guard let window = settingsWindow, window.attachedSheet == nil else { return }
    let panel = NSSavePanel()
    panel.title = "Export Transcript"
    panel.nameFieldStringValue = filename
    panel.allowedContentTypes = [UTType(filenameExtension: format) ?? .plainText]
    panel.canCreateDirectories = true
    panel.beginSheetModal(for: window) { response in
        guard response == .OK, let url = panel.url else { completion(.success(false)); return }
        do { try body.write(to: url, atomically: true, encoding: .utf8); completion(.success(true)) }
        catch { completion(.failure(error)) }
    }
}

private struct SettingsView: View {
    @ObservedObject var model = SettingsModel.shared
    @State private var search = ""
    var body: some View {
        NavigationSplitView {
            List(selection: Binding<Page?>(get: { model.page }, set: { if let page = $0 { model.navigate(page) } })) {
                ForEach(Page.allCases.filter { search.isEmpty || "\($0.rawValue) \($0.keywords)".localizedCaseInsensitiveContains(search) }) { page in
                    Label { Text(page.rawValue) } icon: { Image(systemName: page.symbol).foregroundStyle(page.color) }.tag(page)
                }
            }
            .listStyle(.sidebar)
            .disabled(model.busy)
            .searchable(text: $search, prompt: "Search Settings")
            .navigationSplitViewColumnWidth(min: 170, ideal: 196, max: 250)
        } detail: {
            VStack(spacing: 0) {
                if model.loading && model.preferences == nil {
                    ProgressView("Loading Settings…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if model.preferences == nil {
                    ContentUnavailableView { Label("Settings unavailable", systemImage: "exclamationmark.triangle") } actions: { Button("Try Again") { model.reload() } }
                } else {
                    pageContent
                }
                if !model.error.isEmpty {
                    Text(model.error).foregroundStyle(.red).font(.callout).textSelection(.enabled).padding().frame(maxWidth: .infinity, alignment: .leading).accessibilityLabel("Error: \(model.error)")
                } else if !model.notice.isEmpty {
                    Text(model.notice).font(.callout).foregroundStyle(.secondary).padding().frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .navigationTitle(model.page.rawValue)
            .toolbar {
                ToolbarItemGroup(placement: .navigation) {
                    Button { model.go(-1) } label: { Label("Back", systemImage: "chevron.left") }.disabled(model.navigationIndex == 0)
                    Button { model.go(1) } label: { Label("Forward", systemImage: "chevron.right") }.disabled(model.navigationIndex + 1 == model.navigation.count)
                }
                ToolbarItem(placement: .automatic) { if model.busy { ProgressView().controlSize(.small).accessibilityLabel("Saving") } }
            }
        }
        .tint(dootAccent)
        .preferredColorScheme(.dark)
        .frame(minWidth: 800, minHeight: 520)
        .onChange(of: model.page) { _, _ in model.notice = ""; model.error = "" }
    }
    @ViewBuilder private var pageContent: some View {
        switch model.page {
        case .setup: SetupView()
        case .general: GeneralView()
        case .captions: CaptionsView()
        case .privacy: PrivacyView()
        case .history: HistoryView()
        case .connection: ConnectionView()
        case .about: AboutView()
        }
    }
}

private struct AboutView: View {
    @ObservedObject var model = SettingsModel.shared
    var body: some View {
        Form {
            Section {
                VStack(spacing: 8) {
                    Text("D")
                        .font(.system(size: 28, weight: .bold))
                        .foregroundStyle(Color(red: 23 / 255, green: 24 / 255, blue: 16 / 255))
                        .frame(width: 56, height: 56)
                        .background(dootAccent, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                        .accessibilityHidden(true)
                    Text(model.appName).font(.title2.weight(.semibold))
                    Text("Live captions for your desktop.").font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .listRowBackground(Color.clear)
                .accessibilityElement(children: .combine)
            }
            Section {
                LabeledContent("Version", value: model.appVersion)
            }
        }
        .formStyle(.grouped)
    }
}

private struct GeneralView: View {
    @ObservedObject var model = SettingsModel.shared
    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Open at login", isOn: Binding(get: { model.openAtLogin }, set: { enabled in
                    model.action("login", ["enabled": enabled]) { result in model.openAtLogin = result["enabled"] as? Bool ?? false }
                })).toggleStyle(.switch)
                Text("Start Doot when you sign in to this computer.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Overlay") {
                Button("Reset Overlay Position") { model.action("resetOverlay") }
                Text("Option + Arrow keys move the overlay. ⌘⇧O toggles click-through. The menu bar also provides Unlock Overlay.").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).disabled(model.busy)
    }
}

private struct CaptionsView: View {
    @ObservedObject var model = SettingsModel.shared
    @State private var size = 28.0
    @State private var opacity = 0.42
    @State private var hint = ""
    @State private var saveTask: Task<Void, Never>?
    var body: some View {
        Form {
            Section("Overlay Preview") {
                if let preview = model.overlayPreview {
                    OverlayCanvas(snapshot: preview, fontSize: size, idleOpacity: opacity, interactive: false, revealed: false)
                        .frame(height: 180)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityLabel("Caption appearance preview")
                } else {
                    ProgressView().frame(height: 180)
                }
            }
            Section("Appearance") {
                LabeledContent("Transparency", value: "\(Int((1 - opacity) * 100))%")
                Slider(value: Binding(get: { (1 - opacity) * 100 }, set: { opacity = min(1, max(0, 1 - $0 / 100)) }), in: 0...100) { Text("Idle transparency") }
                Text("From solid to glass to fully clear. Hover adds a little more tint. The live overlay updates as you drag.").font(.caption).foregroundStyle(.secondary)
                LabeledContent("Text size", value: "\(Int(size)) px")
                Slider(value: $size, in: 18...40, step: 1) { Text("Caption text size") }
                Text("Resizing the overlay does not change its text size.").font(.caption).foregroundStyle(.secondary)
            }
            Section("What's playing?") {
                TextField("A match, show, or stream", text: $hint).onChange(of: hint) { _, value in if value.count > 80 { hint = String(value.prefix(80)) } }
                    .onSubmit { model.savePreference(["contextHint": hint]) }
                Button("Save Hint") { model.savePreference(["contextHint": hint]) }.disabled(hint == model.preferences?.contextHint)
                Text("Optional hint for the next capture. Leave blank to infer names from speech.").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
        .onAppear(perform: sync)
        .onChange(of: size) { _, _ in pushAppearance(); scheduleAppearanceSave() }
        .onChange(of: opacity) { _, _ in pushAppearance(); scheduleAppearanceSave() }
        .onChange(of: model.preferences?.captionFontSize) { _, value in
            guard let value else { return }
            if OverlayModel.shared.previewFontSize != nil {
                if abs((OverlayModel.shared.previewFontSize ?? value) - value) < 0.51 { OverlayModel.shared.previewFontSize = nil }
                return
            }
            size = value
        }
        .onChange(of: model.preferences?.overlayIdleOpacity) { _, value in
            guard let value else { return }
            if OverlayModel.shared.previewIdleOpacity != nil {
                if abs((OverlayModel.shared.previewIdleOpacity ?? value) - value) < 0.002 { OverlayModel.shared.previewIdleOpacity = nil }
                return
            }
            opacity = value
        }
        .onChange(of: model.preferences?.contextHint) { _, value in if let value { hint = value } }
        .onReceive(NotificationCenter.default.publisher(for: .dootSettingsWillHide)) { _ in flushAppearance() }
        .onDisappear { flushAppearance() }
    }
    private func sync() {
        guard let prefs = model.preferences else { return }
        size = prefs.captionFontSize; opacity = prefs.overlayIdleOpacity; hint = prefs.contextHint
        pushAppearance()
    }
    private func pushAppearance() {
        OverlayModel.shared.previewAppearance(fontSize: size, idleOpacity: opacity)
    }
    private func scheduleAppearanceSave() {
        saveTask?.cancel()
        saveTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(160))
            guard !Task.isCancelled else { return }
            saveAppearance()
        }
    }
    private func flushAppearance() {
        saveTask?.cancel()
        saveAppearance()
        OverlayModel.shared.applyPreviewToSnapshot()
        if hint != model.preferences?.contextHint { model.savePreference(["contextHint": hint]) }
    }
    private func saveAppearance() {
        var patch: JSON = [:]
        let font = Int(size.rounded())
        let idle = min(1, max(0, opacity))
        if font != Int(model.preferences?.captionFontSize.rounded() ?? -1) { patch["captionFontSize"] = font }
        if abs(idle - (model.preferences?.overlayIdleOpacity ?? -1)) > 0.001 { patch["overlayIdleOpacity"] = idle }
        if !patch.isEmpty { model.savePreference(patch) }
    }
}

private struct SetupView: View {
    @ObservedObject var model = SettingsModel.shared
    @State private var provider = "sarvam"
    @State private var key = ""
    private let providers = ["sarvam", "gemini", "speechmatics", "openai"]
    var body: some View {
        Form {
            Section("Speech Services") {
                Text("Sarvam covers English and Indic speech. Gemini covers international routes. Speechmatics and OpenAI are available for comparison.").font(.callout).foregroundStyle(.secondary)
                Picker("Provider", selection: $provider) {
                    ForEach(providers, id: \.self) { id in Text("\(id == "openai" ? "OpenAI" : id.capitalized)\(model.keys[id] == true ? " · Saved" : "")").tag(id) }
                }.onChange(of: provider) { _, _ in key = "" }
                SecureField("API key", text: $key).textContentType(.password).onSubmit(saveKey)
                HStack {
                    Button("Save Key", action: saveKey).disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Remove Saved Key", role: .destructive) {
                        confirm(title: "Remove the saved \(provider == "openai" ? "OpenAI" : provider.capitalized) key?", message: "Routes using this provider will be unavailable until you add another key.", action: "Remove Key") {
                            model.action("key", ["provider": provider, "key": ""], success: "Saved key removed.") { result in model.keys = result["keys"] as? [String: Bool] ?? [:] }
                        }
                    }.tint(.red).disabled(model.keys[provider] != true)
                }
                Text(model.captureActive ? "Stop capture before changing provider keys." : "Keys are stored in macOS Keychain.").font(.caption).foregroundStyle(.secondary)
            }.disabled(model.captureActive)
            Section("This Computer") {
                Button("Open Audio Permissions") { model.action("audioSettings") }
                Button("Check Readiness") { model.action("readiness") { result in model.notice = result["message"] as? String ?? "" } }
                Button("Check Audio for 3 Seconds") { model.action("checkAudio") { result in model.notice = result["message"] as? String ?? "" } }
                Button("Finish Setup") { model.action("prefs", ["onboardingComplete": true]) { result in model.acceptPreferences(result); model.navigate(.captions) } }
            }
            Section {
                Text("Captions send audio to your selected providers and may incur charges. Finalized transcripts are saved locally by default; change this in Privacy. Readiness and audio checks do not send or save audio.").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).disabled(model.busy)
        .onDisappear { key = "" }
    }
    private func saveKey() {
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !model.busy, !model.captureActive else { return }
        model.action("key", ["provider": provider, "key": key], success: "Key saved securely. Caption service restarted. Readiness does not verify billing or key validity.") { result in
            key = ""; model.keys = result["keys"] as? [String: Bool] ?? [:]
        }
    }
}

private struct PrivacyView: View {
    @ObservedObject var model = SettingsModel.shared
    var body: some View {
        Form {
            Section {
                Text("Audio is sent to your selected speech provider. Text may also be sent to a translation provider. Doot does not save raw audio. Saved transcripts are stored on this computer without application-level encryption.").font(.callout).foregroundStyle(.secondary)
            }
            Section("History") {
                Toggle("Save caption history", isOn: Binding(get: { model.policy?.saveHistory ?? false }, set: { model.savePolicy($0, model.policy?.retentionDays ?? 0) })).toggleStyle(.switch)
                Text("Applies to new sessions. Turning this off keeps existing history.").font(.caption).foregroundStyle(.secondary)
                Picker("Keep history", selection: $model.retention) {
                    Text("Until I delete it").tag(0)
                    ForEach([7, 30, 90], id: \.self) { Text("\($0) days").tag($0) }
                }
                if let policy = model.policy, model.retention != policy.retentionDays {
                    Button("Apply Retention") {
                        let days = model.retention
                        if days == 0 { model.savePolicy(policy.saveHistory, days) }
                        else {
                            confirm(title: "Delete history older than \(days) days?", message: "This immediately and permanently removes older finished sessions. Active sessions are kept.", action: "Delete and Apply") { model.savePolicy(policy.saveHistory, days) }
                        }
                    }
                }
                Text("Individual sessions can be exported or deleted from History. Provider data handling follows your provider account terms.").font(.caption).foregroundStyle(.secondary)
            }.disabled(model.policy == nil)
        }.formStyle(.grouped).disabled(model.busy).onAppear { model.loadPolicy() }
    }
}

private struct HistoryView: View {
    @ObservedObject var model = SettingsModel.shared
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Search names, captions, or languages", text: $model.historyQuery).textFieldStyle(.roundedBorder)
                    .onChange(of: model.historyQuery) { _, _ in model.searchHistory() }
                Button { model.refreshHistory() } label: { Label("Refresh", systemImage: "arrow.clockwise") }.labelStyle(.iconOnly).disabled(model.historyLoading)
            }.padding()
            HSplitView {
                VStack(spacing: 0) {
                    List(selection: Binding<String?>(get: { model.selected }, set: model.loadDetail)) {
                        ForEach(model.sessions) { session in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(session.name).font(.headline).lineLimit(1)
                                Text(model.pair(session.sourceLanguage, session.targetLanguage)).font(.caption).foregroundStyle(.secondary)
                                Text("\(session.segmentCount) captions\(session.interrupted == true ? " · Interrupted" : "")").font(.caption).foregroundStyle(.secondary)
                                Text(session.preview).font(.caption).lineLimit(2).foregroundStyle(.secondary)
                            }.padding(.vertical, 4).tag(session.id)
                            .contextMenu {
                                Button("Open") { model.loadDetail(session.id) }
                                Button("Copy Transcript") { model.copySession(session.id) }
                                Menu("Export") { exportButtons(session.id) }
                                Divider()
                                Button("Delete", role: .destructive) { model.deleteSession(session.id) }
                            }
                        }
                    }
                    if model.historyLoading { ProgressView().controlSize(.small).padding(8) }
                    if !model.historyLoading && model.sessions.isEmpty { Text(model.historyQuery.isEmpty ? "Finished sessions appear here." : "No matching sessions.").foregroundStyle(.secondary).padding() }
                    HStack {
                        Button { model.historyPage -= 1; model.refreshHistory(reset: false) } label: { Image(systemName: "chevron.left") }.accessibilityLabel("Previous page").disabled(model.historyPage == 0)
                        Text("Page \(model.historyPage + 1)").font(.caption).foregroundStyle(.secondary)
                        Button { model.historyPage += 1; model.refreshHistory(reset: false) } label: { Image(systemName: "chevron.right") }.accessibilityLabel("Next page").disabled(!model.hasMore)
                    }.disabled(model.historyLoading).padding(10)
                }.frame(minWidth: 190, idealWidth: 220, maxWidth: 300)
                Group {
                    if model.detailLoading { ProgressView("Loading transcript…") }
                    else if let detail = model.detail { HistoryDetailView(detail: detail).id(detail.id) }
                    else { ContentUnavailableView("Select a Session", systemImage: "captions.bubble", description: Text("Read, copy, or export a saved transcript.")) }
                }.frame(minWidth: 260, maxWidth: .infinity, maxHeight: .infinity)
            }
        }.onAppear { model.refreshHistory() }
    }
    @ViewBuilder private func exportButtons(_ id: String) -> some View {
        Button("Text") { model.exportSession(id, "txt") }
        Button("Subtitles") { model.exportSession(id, "srt") }
        Button("JSON") { model.exportSession(id, "json") }
    }
}

private struct HistoryDetailView: View {
    @ObservedObject var model = SettingsModel.shared
    let detail: Detail
    @State private var name = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                TextField("Session name", text: $name).textFieldStyle(.roundedBorder).onSubmit(rename)
                    .onChange(of: name) { _, value in if value.count > 120 { name = String(value.prefix(120)) } }
                Button("Save", action: rename).disabled(name == (detail.title ?? ""))
            }
            Text(Date(timeIntervalSince1970: detail.startedAtMs / 1000).formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
            if detail.interrupted == true { Text("This session was interrupted. Its ending may be incomplete.").font(.callout).foregroundStyle(.secondary) }
            HStack {
                Button { model.copySession(detail.id) } label: { Label("Copy", systemImage: "doc.on.doc") }
                Menu {
                    Button("Text") { model.exportSession(detail.id, "txt") }
                    Button("Subtitles") { model.exportSession(detail.id, "srt") }
                    Button("JSON") { model.exportSession(detail.id, "json") }
                } label: { Label("Export", systemImage: "square.and.arrow.up") }
                Spacer()
                Button(role: .destructive) { model.deleteSession(detail.id) } label: { Label("Delete", systemImage: "trash") }.labelStyle(.iconOnly).tint(.red)
            }
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if detail.segments.isEmpty { Text("This session has no saved captions.").foregroundStyle(.secondary) }
                    ForEach(detail.segments.filter { !$0.translatedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { segment in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(segment.time).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            Text(segment.translatedText).font(.body).textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }.padding(.vertical, 4)
            }.environment(\.layoutDirection, ["ar", "fa", "he", "ks", "sd", "ur"].contains(detail.targetLanguage) ? .rightToLeft : .leftToRight)
        }.padding().disabled(model.busy).onAppear { name = detail.title ?? "" }
    }
    private func rename() {
        model.action("rename", ["id": detail.id, "title": name], success: "Session name saved.") { _ in model.loadDetail(detail.id); model.refreshHistory(reset: false) }
    }
}

private struct ConnectionView: View {
    @ObservedObject var model = SettingsModel.shared
    @State private var detailsExpanded = false
    @State private var timingsExpanded = false
    var body: some View {
        Form {
            Section("Status") {
                if model.status.isEmpty { ProgressView("Checking connection…") }
                ForEach(model.status) { row in
                    LabeledContent(row.title) {
                        Label(row.value, systemImage: row.ok ? "checkmark.circle.fill" : "circle").foregroundStyle(row.ok ? dootAccent : Color.secondary)
                    }
                }
            }
            Section("Actions") {
                Button("Check Again") { model.action("readiness") { result in model.notice = result["message"] as? String ?? ""; Task { await model.refreshConnection() } } }
                Button("Open System Audio Settings") { model.action("audioSettings") }
            }.disabled(model.busy)
            DisclosureGroup("Connection Details", isExpanded: $detailsExpanded) {
                Text(model.routeDescription).textSelection(.enabled)
                Text("Doot manages its caption service. Add or change keys in Setup; stop capture before changing keys.").foregroundStyle(.secondary)
            }
            DisclosureGroup("Caption Timing Diagnostics", isExpanded: $timingsExpanded) {
                Text("Last 500 samples from this app run. No audio, captions, keys, or session identifiers. Display lag estimates a browser paint opportunity, not physical display latency.").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Read Timings") { model.action("timings") { result in model.diagnostics = result["text"] as? String ?? ""; model.diagnosticsJSON = result["json"] as? String ?? "" } }.disabled(model.busy)
                    Button("Copy Diagnostics") { model.copy(model.diagnosticsJSON, notice: "Timing diagnostics copied.") }.disabled(model.diagnosticsJSON.isEmpty)
                }
                Text(model.diagnostics).font(.callout.monospacedDigit()).textSelection(.enabled)
            }
        }.formStyle(.grouped)
        .task {
            while !Task.isCancelled {
                if settingsWindow?.isVisible == true { await model.refreshConnection() }
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
            }
        }
    }
}

struct LanguageChoice: Decodable, Identifiable { let id: String; let label: String }
private struct LanguageOptions: Decodable {
    let key: String
    let selected: String
    let choices: [LanguageChoice]
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    init(key: String, selected: String, choices: [LanguageChoice], x: Double, y: Double, width: Double, height: Double) {
        self.key = key; self.selected = selected; self.choices = choices; self.x = x; self.y = y; self.width = width; self.height = height
    }
    private enum CodingKeys: String, CodingKey { case key, selected, choices, x, y, width, height }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decode(String.self, forKey: .key)
        selected = try container.decode(String.self, forKey: .selected)
        choices = try container.decode([LanguageChoice].self, forKey: .choices)
        x = try container.decode(LosslessDouble.self, forKey: .x).value
        y = try container.decode(LosslessDouble.self, forKey: .y).value
        width = try container.decode(LosslessDouble.self, forKey: .width).value
        height = try container.decode(LosslessDouble.self, forKey: .height).value
    }
}
private func languagePickerSize(rowCount: Int) -> NSSize {
    let rows = min(max(rowCount, 3), 7)
    return NSSize(width: 208, height: 36 + CGFloat(rows) * 26)
}

private struct LanguagePickerView: View {
    let options: LanguageOptions
    @State private var search = ""
    @State private var highlighted: String?
    @State private var saving = false
    @State private var error = ""
    @FocusState private var searchFocused: Bool
    private var choices: [LanguageChoice] {
        options.choices.filter { search.isEmpty || $0.label.localizedCaseInsensitiveContains(search) || $0.id.localizedCaseInsensitiveContains(search) }
    }
    var body: some View {
        ScrollViewReader { proxy in
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
                    TextField("Find a language", text: $search)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13))
                        .focused($searchFocused)
                        .onSubmit { select(highlighted ?? choices.first?.id) }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
                ScrollView {
                    LazyVStack(spacing: 1) {
                        ForEach(choices) { choice in
                            LanguageMenuRow(
                                title: choice.label,
                                selected: choice.id == options.selected,
                                highlighted: choice.id == highlighted
                            ) { select(choice.id) }
                            .id(choice.id)
                            .onHover { hovering in
                                if hovering { highlighted = choice.id }
                            }
                        }
                    }
                    .padding(5)
                }
                .scrollIndicators(.automatic)
                if choices.isEmpty {
                    Text("No matching languages").font(.system(size: 12)).foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                if !error.isEmpty {
                    Text(error).font(.system(size: 11, weight: .medium)).foregroundStyle(.red).padding(.horizontal, 10).padding(.bottom, 8)
                }
            }
            .frame(width: languagePickerSize(rowCount: options.choices.count).width, height: languagePickerSize(rowCount: options.choices.count).height)
            .onAppear {
                highlighted = options.selected
                searchFocused = true
                proxy.scrollTo(options.selected, anchor: .center)
            }
            .onChange(of: search) { _, _ in
                let next = choices.contains(where: { $0.id == highlighted }) ? highlighted : choices.first?.id
                highlighted = next
                if let next { proxy.scrollTo(next, anchor: .center) }
            }
            .onKeyPress(.upArrow) { moveHighlight(-1, scroll: { proxy.scrollTo($0, anchor: .center) }); return .handled }
            .onKeyPress(.downArrow) { moveHighlight(1, scroll: { proxy.scrollTo($0, anchor: .center) }); return .handled }
        }
        .disabled(saving)
        .tint(dootAccent)
        .preferredColorScheme(.dark)
        .onExitCommand { languagePopover?.close() }
        .onKeyPress(.return) {
            select(highlighted ?? choices.first?.id)
            return .handled
        }
    }
    private func moveHighlight(_ delta: Int, scroll: (String) -> Void) {
        guard !choices.isEmpty else { return }
        let current = highlighted.flatMap { id in choices.firstIndex(where: { $0.id == id }) } ?? (delta > 0 ? -1 : 0)
        let id = choices[min(max(current + delta, 0), choices.count - 1)].id
        highlighted = id
        scroll(id)
    }
    private func select(_ id: String?) {
        guard let id, !saving else { return }
        saving = true
        Task {
            do { _ = try await Bridge.shared.request("language", ["key": options.key, "value": id]); languagePopover?.close() }
            catch { self.error = error.localizedDescription; saving = false }
        }
    }
}

private struct LanguageMenuRow: View {
    let title: String
    let selected: Bool
    let highlighted: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(dootAccent)
                    .opacity(selected ? 1 : 0)
                    .frame(width: 14)
                Text(title).font(.system(size: 13, weight: selected ? .medium : .regular)).lineLimit(1)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Color(red: 245 / 255, green: 245 / 255, blue: 239 / 255))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(highlighted ? Color.white.opacity(0.14) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel(title)
    }
}

@MainActor private final class WindowDelegate: NSObject, NSWindowDelegate, NSPopoverDelegate {
    static let shared = WindowDelegate()
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        NotificationCenter.default.post(name: .dootSettingsWillHide, object: nil)
        sender.orderOut(nil)
        return false
    }
    func windowDidBecomeKey(_ notification: Notification) {
        guard (notification.object as? NSWindow) === settingsWindow else { return }
        guard OverlayModel.shared.previewIdleOpacity == nil, OverlayModel.shared.previewFontSize == nil else { return }
        SettingsModel.shared.reload()
        if SettingsModel.shared.page == .history { SettingsModel.shared.refreshHistory() }
    }
    func popoverDidClose(_ notification: Notification) { languageAnchor?.removeFromSuperview(); languageAnchor = nil; languagePopover = nil }
}

@_cdecl("doot_native_init")
func nativeInit(_ callback: @escaping @convention(c) (UnsafePointer<CChar>) -> Void) { sendToController = callback }

@_cdecl("doot_native_ready")
func nativeReady() {
    MainActor.assumeIsolated { Bridge.shared.ready = true; if settingsWindow?.isVisible == true { SettingsModel.shared.reload() } }
}

@_cdecl("doot_native_open")
func nativeOpen() {
    MainActor.assumeIsolated {
        if settingsWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 860, height: 640), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
            window.title = "Doot Settings"
            window.titlebarAppearsTransparent = true
            window.toolbarStyle = .unified
            window.appearance = NSAppearance(named: .darkAqua)
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 800, height: 520)
            window.setFrameAutosaveName("DootNativeSettings")
            window.contentViewController = NSHostingController(rootView: SettingsView())
            window.delegate = WindowDelegate.shared
            window.setContentSize(NSSize(width: 860, height: 640))
            if !window.setFrameUsingName("DootNativeSettings") { window.center() }
            settingsWindow = window
        }
        settingsWindow?.deminiaturize(nil)
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if Bridge.shared.ready { SettingsModel.shared.reload() }
    }
}

@_cdecl("doot_native_receive")
func nativeReceive(_ json: UnsafePointer<CChar>) {
    let data = Data(String(cString: json).utf8)
    MainActor.assumeIsolated {
        if let value = try? JSONSerialization.jsonObject(with: data) as? JSON { Bridge.shared.receive(value) }
    }
}

@MainActor func presentLanguagePicker(window: NSWindow, key: String, selected: String, choices: [LanguageChoice], anchor: NSRect) {
    guard ["sourceLanguage", "targetLanguage"].contains(key),
          choices.count <= 100, choices.allSatisfy({ $0.id.count <= 16 && $0.label.count <= 100 }),
          anchor.width > 0, anchor.height > 0,
          [anchor.minX, anchor.minY, anchor.width, anchor.height].allSatisfy(\.isFinite) else { return }
    guard let content = window.contentView else { return }
    languagePopover?.close()
    let view = NSView(frame: anchor)
    content.addSubview(view)
    let options = LanguageOptions(key: key, selected: selected, choices: choices, x: anchor.minX, y: anchor.minY, width: anchor.width, height: anchor.height)
    let hosting = NSHostingController(rootView: LanguagePickerView(options: options))
    let popover = NSPopover()
    popover.behavior = .transient
    popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    popover.appearance = NSAppearance(named: .darkAqua)
    popover.contentSize = languagePickerSize(rowCount: choices.count)
    popover.contentViewController = hosting
    popover.delegate = WindowDelegate.shared
    languageAnchor = view
    languagePopover = popover
    // Do not activate the app: this popover belongs to the nonactivating captions panel.
    popover.show(relativeTo: view.bounds, of: view, preferredEdge: .maxY)
}

@_cdecl("doot_native_picker")
func nativePicker(_ pointer: UnsafeMutableRawPointer, _ json: UnsafePointer<CChar>) {
    let data = Data(String(cString: json).utf8)
    MainActor.assumeIsolated {
        guard let options = try? JSONDecoder().decode(LanguageOptions.self, from: data) else { return }
        let window = Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue()
        guard let content = window.contentView else { return }
        let y = content.isFlipped ? options.y : content.bounds.height - options.y - options.height
        presentLanguagePicker(window: window, key: options.key, selected: options.selected, choices: options.choices, anchor: NSRect(x: options.x, y: y, width: options.width, height: options.height))
    }
}

@_cdecl("doot_native_about")
func nativeAbout() {
    MainActor.assumeIsolated {
        nativeOpen()
        if SettingsModel.shared.page != .about { SettingsModel.shared.navigate(.about) }
    }
}
