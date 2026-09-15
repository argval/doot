import AppKit
import SwiftUI
import WebKit

struct OverlayLine: Decodable, Identifiable, Hashable {
    let id: String
    let text: String
    let live: Bool
    var speaker: Int?
}

struct OverlayPair: Decodable, Hashable {
    let source: String
    let target: String
    let label: String
}

struct OverlaySnapshot: Decodable {
    var lines: [OverlayLine]
    var targetLanguage: String
    var sourceLanguage: String
    var script: String
    var translating: Bool
    var capturing: Bool
    var transitioning: Bool
    var locked: Bool
    var error: String
    var notice: String
    var status: String
    var placeholder: String
    var announcement: String
    var audioLevel: Double
    var listening: Bool
    var clickThrough: Bool
    var fontSize: Double
    var idleOpacity: Double
    var sourceLabel: String
    var targetLabel: String
    var captureHint: String
    var recent: [OverlayPair]
    var sourceChoices: [LanguageChoice]
    var targetChoices: [LanguageChoice]

    private enum CodingKeys: String, CodingKey {
        case lines, targetLanguage, sourceLanguage, script, translating, capturing, transitioning, locked
        case error, notice, status, placeholder, announcement, audioLevel, listening, clickThrough
        case fontSize, idleOpacity, sourceLabel, targetLabel, captureHint, recent, sourceChoices, targetChoices
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        lines = try container.decode([OverlayLine].self, forKey: .lines)
        targetLanguage = try container.decode(String.self, forKey: .targetLanguage)
        sourceLanguage = try container.decode(String.self, forKey: .sourceLanguage)
        script = try container.decode(String.self, forKey: .script)
        translating = try container.decode(Bool.self, forKey: .translating)
        capturing = try container.decode(Bool.self, forKey: .capturing)
        transitioning = try container.decode(Bool.self, forKey: .transitioning)
        locked = try container.decode(Bool.self, forKey: .locked)
        error = try container.decode(String.self, forKey: .error)
        notice = try container.decode(String.self, forKey: .notice)
        status = try container.decode(String.self, forKey: .status)
        placeholder = try container.decode(String.self, forKey: .placeholder)
        announcement = try container.decode(String.self, forKey: .announcement)
        audioLevel = try container.decode(LosslessDouble.self, forKey: .audioLevel).value
        listening = try container.decode(Bool.self, forKey: .listening)
        clickThrough = try container.decode(Bool.self, forKey: .clickThrough)
        fontSize = try container.decode(LosslessDouble.self, forKey: .fontSize).value
        idleOpacity = try container.decode(LosslessDouble.self, forKey: .idleOpacity).value
        sourceLabel = try container.decode(String.self, forKey: .sourceLabel)
        targetLabel = try container.decode(String.self, forKey: .targetLabel)
        captureHint = try container.decode(String.self, forKey: .captureHint)
        recent = try container.decode([OverlayPair].self, forKey: .recent)
        sourceChoices = try container.decode([LanguageChoice].self, forKey: .sourceChoices)
        targetChoices = try container.decode([LanguageChoice].self, forKey: .targetChoices)
    }
}

private let overlayFill = Color(red: 25 / 255, green: 26 / 255, blue: 23 / 255)
private let overlayInk = Color(red: 245 / 255, green: 245 / 255, blue: 239 / 255)
private let overlayMuted = overlayInk.opacity(0.9)
private let overlayError = Color(red: 1, green: 170 / 255, blue: 161 / 255)
private let overlayOlive = Color(red: 89 / 255, green: 101 / 255, blue: 46 / 255)
private let overlaySpring = Animation.interactiveSpring(response: 0.28, dampingFraction: 1)

@MainActor final class OverlayModel: NSObject, ObservableObject {
    static let shared = OverlayModel()
    @Published var snapshot: OverlaySnapshot?
    @Published var hovered = false
    @Published var keyWindow = false
    @Published var previewIdleOpacity: Double?
    @Published var previewFontSize: Double?
    weak var window: NSWindow?
    var lastAnnouncement = ""

    var revealed: Bool {
        hovered || keyWindow || NSWorkspace.shared.isVoiceOverEnabled
    }

    var effectiveIdleOpacity: Double {
        min(1, max(0, previewIdleOpacity ?? snapshot?.idleOpacity ?? 0.42))
    }

    var effectiveFontSize: Double {
        min(40, max(18, (previewFontSize ?? snapshot?.fontSize ?? 28).rounded()))
    }

    func previewAppearance(fontSize: Double, idleOpacity: Double) {
        previewFontSize = fontSize
        previewIdleOpacity = idleOpacity
        overlayChrome?.applyGlassAppearance()
    }

    func applyPreviewToSnapshot() {
        guard var snapshot = snapshot else { return }
        snapshot.fontSize = effectiveFontSize
        snapshot.idleOpacity = effectiveIdleOpacity
        self.snapshot = snapshot
    }

    func accept(_ value: JSON) {
        var payload = value
        payload.removeValue(forKey: "event")
        guard let next = try? decode(OverlaySnapshot.self, payload) else { return }
        guard next.lines.count <= 8 else { return }
        var snapshot = next
        snapshot.fontSize = previewFontSize ?? min(40, max(18, next.fontSize.rounded()))
        snapshot.idleOpacity = previewIdleOpacity ?? min(1, max(0, next.idleOpacity))
        if let preview = previewFontSize, abs(preview - next.fontSize) < 0.51 { previewFontSize = nil }
        if let preview = previewIdleOpacity, abs(preview - next.idleOpacity) < 0.002 { previewIdleOpacity = nil }
        self.snapshot = snapshot
        overlayChrome?.applyGlassAppearance()
        overlayChrome?.needsLayout = true
        if next.announcement != lastAnnouncement {
            lastAnnouncement = next.announcement
            if !next.announcement.isEmpty, let host = overlayChrome {
                NSAccessibility.post(element: host, notification: .announcementRequested, userInfo: [.announcement: next.announcement])
            }
        }
    }

    @objc func applyRecent(_ sender: NSMenuItem) {
        guard let token = sender.representedObject as? String else { return }
        let parts = token.split(separator: "\u{1e}", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return }
        OverlayModel.shared.action("recent", ["source": String(parts[0]), "target": String(parts[1])])
    }

    func action(_ operation: String, _ args: JSON = [:]) {
        Task { _ = try? await Bridge.shared.request(operation, args) }
    }
}

@MainActor var overlayChrome: OverlayChromeView?
@MainActor private var overlayKeyMonitor: Any?

@MainActor func constrainOverlayFrame(_ window: NSWindow) {
    let minSize = NSSize(width: 360, height: 160)
    let maxSize = NSSize(width: 960, height: 420)
    let defaultSize = NSSize(width: 576, height: 190)
    window.minSize = minSize
    window.maxSize = maxSize
    var frame = window.frame
    if frame.width > maxSize.width + 1 || frame.height > maxSize.height + 1 || frame.width < minSize.width - 1 || frame.height < minSize.height - 1 {
        frame.size = defaultSize
        window.setFrame(frame, display: true)
    }
}

@MainActor func prepareTransparentOverlayWindow(_ window: NSWindow) {
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    guard let content = window.contentView else { return }
    content.wantsLayer = true
    content.layer?.isOpaque = false
    content.layer?.backgroundColor = NSColor.clear.cgColor
    clearWebViewBackgrounds(content)
}

@MainActor private func clearWebViewBackgrounds(_ view: NSView) {
    if let web = view as? WKWebView {
        web.underPageBackgroundColor = .clear
        if web.responds(to: Selector(("setDrawsBackground:"))) {
            web.setValue(false, forKey: "drawsBackground")
        }
    }
    for child in view.subviews { clearWebViewBackgrounds(child) }
}

@MainActor func attachOverlay(to window: NSWindow) {
    prepareTransparentOverlayWindow(window)
    window.isMovableByWindowBackground = true
    constrainOverlayFrame(window)
    if overlayChrome == nil { overlayChrome = OverlayChromeView() }
    guard let host = overlayChrome, let content = window.contentView else { return }
    OverlayModel.shared.window = window
    OverlayModel.shared.keyWindow = window.isKeyWindow
    host.frame = content.bounds
    host.autoresizingMask = [.width, .height]
    if host.superview !== content { content.addSubview(host, positioned: .above, relativeTo: nil) }
    host.applyGlassAppearance()
    host.needsLayout = true
    if overlayKeyMonitor == nil {
        overlayKeyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard OverlayModel.shared.window?.isKeyWindow == true, event.modifierFlags.contains(.option) else { return event }
            let direction: String
            switch event.keyCode {
            case 126: direction = "up"
            case 125: direction = "down"
            case 123: direction = "left"
            case 124: direction = "right"
            default: return event
            }
            OverlayModel.shared.action("moveOverlay", ["direction": direction])
            return nil
        }
    }
}

@_cdecl("doot_native_attach_overlay")
func nativeAttachOverlay(_ pointer: UnsafeMutableRawPointer) {
    MainActor.assumeIsolated {
        attachOverlay(to: Unmanaged<NSWindow>.fromOpaque(pointer).takeUnretainedValue())
    }
}

func overlayDimmingAlpha(idle: Double, revealed: Bool) -> Double {
    if NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency || NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast {
        return 1
    }
    let idle = min(1, max(0, idle))
    return revealed ? min(1, idle + 0.12) : idle
}

func overlayVibrancyAlpha(idle: Double, revealed: Bool) -> Double {
    let fill = overlayDimmingAlpha(idle: idle, revealed: revealed)
    return 4 * fill * (1 - fill)
}

private final class OverlayTintView: NSView {
    override var isOpaque: Bool { false }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = false
        setDimming(0.42)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func setDimming(_ value: Double) {
        layer?.backgroundColor = NSColor(calibratedRed: 25 / 255, green: 26 / 255, blue: 23 / 255, alpha: CGFloat(min(1, max(0, value)))).cgColor
        needsDisplay = true
    }
}

final class OverlayChromeView: NSView {
    private let hosting = OverlayHost(rootView: LiveOverlayView())
    private let grip = OverlayResizeGrip()
    private let dimming = OverlayTintView()
    private let material = NSVisualEffectView()
    private var tracking: NSTrackingArea?

    override var isOpaque: Bool { false }
    override var mouseDownCanMoveWindow: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = false
        layer?.backgroundColor = NSColor.clear.cgColor
        layer?.cornerRadius = 16
        layer?.masksToBounds = true
        material.material = .hudWindow
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 16
        material.layer?.masksToBounds = true
        material.translatesAutoresizingMaskIntoConstraints = false
        dimming.translatesAutoresizingMaskIntoConstraints = false
        hosting.translatesAutoresizingMaskIntoConstraints = false
        hosting.sizingOptions = []
        addSubview(material)
        addSubview(dimming)
        addSubview(hosting)
        addSubview(grip)
        NSLayoutConstraint.activate([
            material.leadingAnchor.constraint(equalTo: leadingAnchor),
            material.trailingAnchor.constraint(equalTo: trailingAnchor),
            material.topAnchor.constraint(equalTo: topAnchor),
            material.bottomAnchor.constraint(equalTo: bottomAnchor),
            dimming.leadingAnchor.constraint(equalTo: leadingAnchor),
            dimming.trailingAnchor.constraint(equalTo: trailingAnchor),
            dimming.topAnchor.constraint(equalTo: topAnchor),
            dimming.bottomAnchor.constraint(equalTo: bottomAnchor),
            hosting.leadingAnchor.constraint(equalTo: leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: trailingAnchor),
            hosting.topAnchor.constraint(equalTo: topAnchor),
            hosting.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        NotificationCenter.default.addObserver(self, selector: #selector(keyChanged), name: NSWindow.didBecomeKeyNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyChanged), name: NSWindow.didResignKeyNotification, object: nil)
        setAccessibilityRole(.group)
        setAccessibilityLabel("Doot live captions")
        setAccessibilityElement(true)
        applyGlassAppearance()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window { prepareTransparentOverlayWindow(window) }
        applyGlassAppearance()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        if OverlayModel.shared.snapshot?.clickThrough == true { return nil }
        return super.hitTest(point)
    }

    func applyGlassAppearance() {
        let revealed = OverlayModel.shared.revealed
        let idle = OverlayModel.shared.effectiveIdleOpacity
        let frost = overlayVibrancyAlpha(idle: idle, revealed: revealed)
        dimming.setDimming(overlayDimmingAlpha(idle: idle, revealed: revealed))
        material.alphaValue = CGFloat(frost)
        material.isHidden = frost < 0.01
        grip.isHidden = !revealed || OverlayModel.shared.snapshot?.clickThrough == true
        if let window { prepareTransparentOverlayWindow(window) }
    }

    override func layout() {
        super.layout()
        grip.frame = NSRect(x: bounds.width - 26, y: 8, width: 18, height: 18)
        applyGlassAppearance()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        OverlayModel.shared.hovered = true
        applyGlassAppearance()
    }

    override func mouseExited(with event: NSEvent) {
        OverlayModel.shared.hovered = false
        applyGlassAppearance()
    }

    @objc private func keyChanged(_ notification: Notification) {
        guard (notification.object as? NSWindow) === OverlayModel.shared.window else { return }
        OverlayModel.shared.keyWindow = OverlayModel.shared.window?.isKeyWindow == true
        applyGlassAppearance()
    }
}

private final class OverlayHost: NSHostingView<LiveOverlayView> {
    override var isOpaque: Bool { false }
    override var mouseDownCanMoveWindow: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        wantsLayer = true
        layer?.isOpaque = false
        layer?.backgroundColor = NSColor.clear.cgColor
        if let window { prepareTransparentOverlayWindow(window) }
    }
}

private final class OverlayResizeGrip: NSView {
    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        setAccessibilityRole(.button)
        setAccessibilityLabel("Resize captions")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        if #available(macOS 15.0, *) {
            addCursorRect(bounds, cursor: .frameResize(position: .bottomRight, directions: .all))
        } else {
            addCursorRect(bounds, cursor: .crosshair)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(red: 245 / 255, green: 245 / 255, blue: 239 / 255, alpha: 0.78).setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1.25
        path.lineCapStyle = .round
        path.move(to: NSPoint(x: 15, y: 3)); path.line(to: NSPoint(x: 3, y: 15))
        path.move(to: NSPoint(x: 15, y: 7)); path.line(to: NSPoint(x: 7, y: 15))
        path.move(to: NSPoint(x: 15, y: 11.2)); path.line(to: NSPoint(x: 11.2, y: 15))
        path.stroke()
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        var frame = window.frame
        var last = event.locationInWindow
        while let next = window.nextEvent(matching: [.leftMouseDragged, .leftMouseUp]) {
            if next.type == .leftMouseUp { break }
            let current = next.locationInWindow
            let dx = current.x - last.x
            let dy = current.y - last.y
            last = current
            frame.size.width = min(960, max(360, frame.size.width + dx))
            frame.size.height = min(420, max(160, frame.size.height - dy))
            frame.origin.y += dy
            window.setFrame(frame, display: true)
        }
    }
}

private struct LiveOverlayView: View {
    @ObservedObject var model = OverlayModel.shared
    var body: some View {
        Group {
            if let snapshot = model.snapshot {
                OverlayCanvas(snapshot: snapshot, fontSize: model.effectiveFontSize, idleOpacity: model.effectiveIdleOpacity, interactive: true, revealed: model.revealed)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.clear)
    }
}

private struct OverlayPreviewScene: View {
    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.54, green: 0.63, blue: 0.78),
                    Color(red: 0.29, green: 0.32, blue: 0.28),
                    Color(red: 0.11, green: 0.13, blue: 0.11),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Circle()
                .fill(Color(red: 0.42, green: 0.56, blue: 0.31).opacity(0.55))
                .frame(width: 220, height: 220)
                .offset(x: 90, y: 40)
                .blur(radius: 18)
            Circle()
                .fill(Color(red: 0.75, green: 0.72, blue: 0.62).opacity(0.45))
                .frame(width: 160, height: 160)
                .offset(x: -80, y: -30)
                .blur(radius: 14)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct OverlayPreviewGlass: NSViewRepresentable {
    func makeNSView(context: Context) -> OverlayPreviewGlassView {
        OverlayPreviewGlassView()
    }

    func updateNSView(_ nsView: OverlayPreviewGlassView, context: Context) {}
}

private final class OverlayPreviewGlassView: NSView {
    override var isOpaque: Bool { false }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
    private let scene = NSHostingView(rootView: OverlayPreviewScene())
    private var material: NSView?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
        scene.autoresizingMask = [.width, .height]
        scene.sizingOptions = []
        addSubview(scene)
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.cornerRadius = 16
            glass.style = .clear
            glass.autoresizingMask = [.width, .height]
            addSubview(glass)
            material = glass
        } else {
            let visual = NSVisualEffectView()
            visual.material = .hudWindow
            visual.blendingMode = .withinWindow
            visual.state = .active
            visual.wantsLayer = true
            visual.layer?.cornerRadius = 16
            visual.autoresizingMask = [.width, .height]
            addSubview(visual)
            material = visual
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        scene.frame = bounds
        material?.frame = bounds
    }
}

struct OverlayCanvas: View {
    let snapshot: OverlaySnapshot
    var fontSize: Double
    var idleOpacity: Double
    var interactive: Bool
    var revealed: Bool
    @State private var previewHover = false

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private var showChrome: Bool { revealed || previewHover }
    private var dimming: Double { overlayDimmingAlpha(idle: idleOpacity, revealed: showChrome) }
    private var vibrancy: Double { overlayVibrancyAlpha(idle: idleOpacity, revealed: showChrome) }
    private var leading: Double {
        switch snapshot.script {
        case "indic": return 1.42
        case "cjk": return 1.35
        case "rtl": return 1.4
        default: return 1.25
        }
    }
    private var tracking: Double { snapshot.script == "latin" ? -0.015 : 0 }
    private var extraLeading: Double { fontSize * (leading - 1) }
    private var rtl: Bool { snapshot.script == "rtl" || ["ar", "fa", "he", "ks", "sd", "ur"].contains(snapshot.targetLanguage) }
    private var locale: Locale {
        switch snapshot.targetLanguage {
        case "od": Locale(identifier: "or")
        case "auto": Locale.current
        default: Locale(identifier: snapshot.targetLanguage)
        }
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if !interactive {
                OverlayPreviewGlass()
                    .opacity(vibrancy)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(overlayFill.opacity(dimming))
                    .allowsHitTesting(false)
            }
            VStack(alignment: .leading, spacing: 8) {
                captions
                if !snapshot.status.isEmpty {
                    HStack(spacing: 6) {
                        AudioBars(level: snapshot.audioLevel, reduceMotion: reduceMotion)
                        Text(snapshot.status).font(.system(size: 11, weight: .medium)).foregroundStyle(overlayMuted)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(snapshot.status)
                }
                if !snapshot.notice.isEmpty || (!snapshot.error.isEmpty && !snapshot.lines.isEmpty) {
                    HStack(alignment: .top, spacing: 8) {
                        noticeText
                        if interactive {
                            Button("Open Settings") { OverlayModel.shared.action("openSettings") }
                                .buttonStyle(.plain)
                                .foregroundStyle(dootAccent)
                                .font(.system(size: 12, weight: .semibold))
                        }
                    }
                }
            }
            .padding(.top, 30)
            .padding(.horizontal, 18)
            .padding(.bottom, 10)
            .environment(\.layoutDirection, rtl ? .rightToLeft : .leftToRight)
            .environment(\.locale, locale)
            if showChrome {
                chip
                    .padding(8)
                    .transition(.opacity)
                    .environment(\.layoutDirection, .leftToRight)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .animation(nil, value: idleOpacity)
        .animation(nil, value: fontSize)
        .animation(reduceMotion ? .easeOut(duration: 0.12) : overlaySpring, value: showChrome)
        .onHover { if !interactive { previewHover = $0 } }
        .allowsHitTesting(interactive ? !snapshot.clickThrough : true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Doot live captions")
    }

    @ViewBuilder private var noticeText: some View {
        let copy = Text(snapshot.error.isEmpty ? snapshot.notice : snapshot.error)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(snapshot.error.isEmpty ? overlayMuted : overlayError)
        if interactive { copy.textSelection(.enabled) } else { copy }
    }

    @ViewBuilder private var captions: some View {
        if !interactive {
            previewCaptions
        } else if !snapshot.error.isEmpty && snapshot.lines.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(snapshot.error).font(captionFont).tracking(fontSize * tracking).lineSpacing(extraLeading).foregroundStyle(overlayError).fixedSize(horizontal: false, vertical: true)
                Button("Open Settings") { OverlayModel.shared.action("openSettings") }
                    .buttonStyle(.plain)
                    .foregroundStyle(dootAccent)
                    .font(.system(size: 13, weight: .semibold))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        } else if snapshot.lines.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if snapshot.listening && snapshot.status.isEmpty { AudioBars(level: snapshot.audioLevel, reduceMotion: reduceMotion) }
                Text(snapshot.placeholder).font(captionFont).tracking(fontSize * tracking).lineSpacing(extraLeading).foregroundStyle(overlayInk.opacity(0.86)).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        } else {
            GeometryReader { geo in
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: fontSize * 0.42) {
                            ForEach(snapshot.lines) { line in
                                CaptionTurn(line: line, font: captionFont, tracking: fontSize * tracking, leading: extraLeading, liveColor: dootAccent)
                                    .id(line.id)
                                    .transition(reduceMotion ? .opacity : .asymmetric(insertion: .opacity.combined(with: .offset(y: -8)), removal: .opacity))
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: geo.size.height, alignment: .bottomLeading)
                        .padding(.bottom, 2)
                    }
                    .scrollIndicators(.hidden)
                    .scrollClipDisabled()
                    .onChange(of: snapshot.lines.last?.id) { _, _ in scrollToLatest(proxy) }
                    .onChange(of: snapshot.lines.last?.text) { _, _ in scrollToLatest(proxy) }
                    .onAppear { scrollToLatest(proxy) }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .mask(LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.08)))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: snapshot.lines.map(\.id))
        }
    }

    private var previewCaptions: some View {
        VStack(alignment: .leading, spacing: fontSize * 0.42) {
            if snapshot.lines.isEmpty {
                Text(snapshot.placeholder).font(captionFont).tracking(fontSize * tracking).lineSpacing(extraLeading).foregroundStyle(overlayInk.opacity(0.86)).fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(snapshot.lines) { line in
                    CaptionTurn(line: line, font: captionFont, tracking: fontSize * tracking, leading: extraLeading, liveColor: dootAccent)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
    }

    private var captionFont: Font {
        .system(size: fontSize, weight: .medium, design: .default)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        guard let id = snapshot.lines.last?.id else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            proxy.scrollTo(id, anchor: .bottom)
        }
    }

    private var chip: some View {
        HStack(spacing: 3) {
            if !snapshot.recent.isEmpty {
                OverlayIcon(systemName: "clock.arrow.circlepath", label: "Recent translation pairs", active: false, disabled: !interactive || snapshot.locked) {
                    showRecentMenu()
                }
            }
            if snapshot.translating {
                languageButton(snapshot.sourceLabel, key: "sourceLanguage", selected: snapshot.sourceLanguage, choices: snapshot.sourceChoices, label: "From")
            } else {
                languageButton(snapshot.targetLabel, key: "targetLanguage", selected: snapshot.targetLanguage, choices: snapshot.targetChoices, label: "Caption language")
            }
            OverlayIcon(
                systemName: "translate",
                label: snapshot.translating ? "Show captions in one language" : "Translate captions",
                active: snapshot.translating,
                disabled: !interactive || snapshot.locked
            ) { OverlayModel.shared.action("translate") }
            if snapshot.translating {
                languageButton(snapshot.targetLabel, key: "targetLanguage", selected: snapshot.targetLanguage, choices: snapshot.targetChoices, label: "To")
            }
            OverlayIcon(
                systemName: snapshot.capturing ? "stop.circle.fill" : "record.circle",
                label: snapshot.captureHint,
                active: snapshot.capturing,
                disabled: !interactive || snapshot.transitioning,
                pulse: interactive && snapshot.capturing && !reduceMotion
            ) { OverlayModel.shared.action("capture") }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .background(overlayFill.opacity(0.42), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
        .preferredColorScheme(.dark)
    }

    private func languageButton(_ title: String, key: String, selected: String, choices: [LanguageChoice], label: String) -> some View {
        Button {
            pickLanguage(key: key, selected: selected, choices: choices)
        } label: {
            HStack(spacing: 2) {
                Text(title).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(overlayInk)
            .frame(minWidth: 72, minHeight: 24)
            .padding(.horizontal, 4)
        }
        .buttonStyle(OverlayPressStyle())
        .disabled(snapshot.locked || !interactive)
        .accessibilityLabel("\(label): \(title)")
        .help(snapshot.locked ? "Stop to change languages" : "Find a language")
    }

    private func pickLanguage(key: String, selected: String, choices: [LanguageChoice]) {
        guard interactive, let window = OverlayModel.shared.window, let event = NSApp.currentEvent, let content = window.contentView else { return }
        let point = content.convert(event.locationInWindow, from: nil)
        presentLanguagePicker(window: window, key: key, selected: selected, choices: choices, anchor: NSRect(x: point.x - 10, y: point.y - 4, width: 20, height: 16))
    }

    private func showRecentMenu() {
        guard interactive, let window = OverlayModel.shared.window, let event = NSApp.currentEvent, let content = window.contentView else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false
        for pair in snapshot.recent {
            let item = NSMenuItem(title: pair.label, action: #selector(OverlayModel.applyRecent(_:)), keyEquivalent: "")
            item.target = OverlayModel.shared
            item.representedObject = "\(pair.source)\u{1e}\(pair.target)"
            item.isEnabled = !snapshot.locked
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: content.convert(event.locationInWindow, from: nil), in: content)
    }
}

private struct CaptionTurn: View {
    let line: OverlayLine
    let font: Font
    var tracking: Double = 0
    var leading: Double = 0
    let liveColor: Color
    var body: some View {
        Text(line.text)
            .font(font)
            .tracking(tracking)
            .lineSpacing(leading)
            .foregroundStyle(line.live ? overlayInk : overlayMuted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 10)
            .overlay(alignment: .leading) {
                Capsule().fill(bar).frame(width: 3)
            }
            .accessibilityLabel(line.text)
    }
    private var bar: Color {
        if line.live { return liveColor }
        switch line.speaker {
        case 1: return liveColor
        case 2: return overlayInk
        case 3: return overlayOlive
        default: return liveColor.opacity(0.35)
        }
    }
}

private struct AudioBars: View {
    let level: Double
    let reduceMotion: Bool
    private var amplitude: Double { min(1, max(0, sqrt(max(0, level)) * 3)) }
    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array([0.6, 1.0, 0.8, 0.5].enumerated()), id: \.offset) { _, weight in
                Capsule()
                    .fill(overlayInk.opacity(0.85))
                    .frame(width: 2, height: reduceMotion ? 8 : 4 + 10 * amplitude * weight)
            }
        }
        .frame(height: 12, alignment: .bottom)
        .animation(reduceMotion ? nil : .interactiveSpring(response: 0.12, dampingFraction: 1), value: amplitude)
        .accessibilityHidden(true)
    }
}

private struct OverlayIcon: View {
    let systemName: String
    let label: String
    var active: Bool
    var disabled: Bool
    var pulse = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(active ? dootAccent : overlayInk.opacity(0.72))
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
                .symbolEffect(.pulse, options: .repeating, isActive: pulse)
        }
        .buttonStyle(OverlayPressStyle())
        .disabled(disabled)
        .accessibilityLabel(label)
        .help(label)
    }
}

private struct OverlayPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}
