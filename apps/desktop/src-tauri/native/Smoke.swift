import AppKit
import SwiftUI

// Standalone smoke driver compiled by check-native-ui.mjs. Not linked into the app.
@MainActor private var smokePrefs: JSON = ["captionFontSize": 28, "overlayIdleOpacity": 0.42, "contextHint": "", "targetLanguage": "en", "onboardingComplete": true]
@MainActor private var smokeDeleted = false
@MainActor private var smokePolicy: JSON = ["saveHistory": true, "retentionDays": 0]
@MainActor private let smokeSession: JSON = ["id": "fixture", "title": "Native UI smoke session", "sourceLanguage": "en", "targetLanguage": "kn", "startedAtMs": 1_789_400_000_000.0, "segmentCount": 2, "preview": "ಕನ್ನಡ ಶೀರ್ಷಿಕೆ", "interrupted": true]
@MainActor private func smokeOverlay(_ fontSize: Double = 28) -> JSON {
    [
        "lines": [
            ["id": "one", "text": "Earlier turns stay on their own lines, a little quieter.", "live": false, "speaker": 2],
            ["id": "two", "text": "The live caption keeps updating as you speak.", "live": true],
        ],
        "targetLanguage": "en", "sourceLanguage": "en", "script": "latin",
        "translating": true, "capturing": false, "transitioning": false, "locked": false,
        "error": "", "notice": "", "status": "", "placeholder": "Your live captions will appear here.",
        "announcement": "", "audioLevel": 0, "listening": false, "clickThrough": false,
        "fontSize": fontSize, "idleOpacity": smokePrefs["overlayIdleOpacity"] ?? 0.42,
        "sourceLabel": "English", "targetLabel": "English", "captureHint": "Start capturing",
        "recent": [], "sourceChoices": [["id": "en", "label": "English"]],
        "targetChoices": [["id": "en", "label": "English"], ["id": "kn", "label": "Kannada"]],
    ]
}
@MainActor private func smokeReply(_ pointer: UnsafePointer<CChar>) {
    let request = try! JSONSerialization.jsonObject(with: Data(String(cString: pointer).utf8)) as! JSON
    let args = request["args"] as! JSON
    let op = request["operation"] as! String
    var result: JSON = [:]
    switch op {
    case "settings": result = ["prefs": smokePrefs, "keys": ["sarvam": true], "openAtLogin": false, "labels": ["en": "English", "kn": "Kannada"], "captureActive": false, "overlay": smokeOverlay()]
    case "prefs":
        smokePrefs.merge(args) { _, next in next }
        result = ["prefs": smokePrefs, "overlay": smokeOverlay((smokePrefs["captionFontSize"] as? NSNumber)?.doubleValue ?? 28)]
    case "login": result = args
    case "policy": result = smokePolicy
    case "savePolicy": smokePolicy = args; result = args
    case "history": result = ["sessions": smokeDeleted ? [] : [smokeSession], "hasMore": false]
    case "detail": result = smokeSession; result["segments"] = [["id": "one", "translatedText": "ಕನ್ನಡ ಶೀರ್ಷಿಕೆ", "startMs": 0], ["id": "two", "translatedText": "یہ ایک جملہ ہے", "startMs": 1200]]
    case "delete": smokeDeleted = true
    case "export": result = ["body": "ಕನ್ನಡ ಶೀರ್ಷಿಕೆ\n", "filename": "doot-smoke.txt"]
    case "connection": result = ["rows": [["title": "Caption service", "value": "Connected", "ok": true], ["title": "Audio permission", "value": "Ready", "ok": true]], "description": "Fixture route. No provider connection."]
    case "timings": result = ["text": "Draft revisions · 0 samples\nEstimated audio → display: p50 — / p95 — ms", "json": "{}"]
    case "key": result = ["keys": ["sarvam": true]]
    case "language": break
    default: break
    }
    let reply: JSON = ["id": request["id"]!, "ok": true, "result": result]
    let text = String(decoding: try! JSONSerialization.data(withJSONObject: reply), as: UTF8.self)
    DispatchQueue.main.async { text.withCString { nativeReceive($0) } }
}

private final class SmokePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@main private enum SmokeRun {
    @MainActor static func pause() async { try? await Task.sleep(for: .milliseconds(650)) }
    @MainActor static func screenshot(_ name: String) {
        guard let window = settingsWindow else { fatalError("Missing native window") }
        let path = ProcessInfo.processInfo.environment["DOOT_SMOKE_OUTPUT"]! + "/" + name + ".png"
        let capture = Process()
        capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-o", "-l", String(window.windowNumber), path]
        try! capture.run(); capture.waitUntilExit()
        if capture.terminationStatus != 0 { print("Window screenshot unavailable: \(name)") }
    }
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        nativeInit { pointer in MainActor.assumeIsolated { smokeReply(pointer) } }
        nativeReady(); nativeOpen()
        Task { @MainActor in
            await pause()
            let model = SettingsModel.shared
            precondition(model.preferences != nil && model.error.isEmpty, "Native bridge did not load settings")
            for page in Page.allCases {
                model.navigate(page)
                await pause()
                screenshot(page.rawValue)
            }
            model.action("login", ["enabled": true]) { result in model.openAtLogin = result["enabled"] as! Bool }
            await pause()
            precondition(model.openAtLogin)
            model.savePreference(["captionFontSize": 32])
            await pause()
            precondition(model.preferences?.captionFontSize == 32)
            model.navigate(.captions)
            await pause()
            precondition(model.overlayPreview?.fontSize == 32, "Caption preview must reflect the native slider")
            model.navigate(.history); model.loadDetail("fixture")
            await pause()
            precondition(model.detail?.segments.count == 2)
            screenshot("Transcript")
            model.deleteSession("fixture")
            await pause()
            precondition(settingsWindow?.attachedSheet != nil, "Delete needs a native sheet")
            screenshot("DeleteSheet")
            settingsWindow!.endSheet(settingsWindow!.attachedSheet!, returnCode: .alertFirstButtonReturn)
            await pause()
            precondition(!smokeDeleted, "Cancel deleted the session")
            model.exportSession("fixture", "txt")
            await pause()
            precondition(settingsWindow?.attachedSheet is NSSavePanel, "Export needs NSSavePanel")
            (settingsWindow?.attachedSheet as? NSSavePanel)?.cancel(nil)
            await pause()
            precondition(!smokeDeleted)
            model.deleteSession("fixture")
            await pause()
            settingsWindow!.endSheet(settingsWindow!.attachedSheet!, returnCode: .alertSecondButtonReturn)
            await pause()
            precondition(smokeDeleted && model.detail == nil)
            settingsWindow?.orderOut(nil)
            let overlay = SmokePanel(contentRect: NSRect(x: 120, y: 120, width: 520, height: 190), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            overlay.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 520, height: 190))
            overlay.isFloatingPanel = true; overlay.hidesOnDeactivate = false
            app.deactivate()
            overlay.orderFrontRegardless()
            await pause()
            nativeAttachOverlay(Unmanaged.passUnretained(overlay).toOpaque())
            precondition(abs(overlay.frame.width - 520) < 1 && abs(overlay.frame.height - 190) < 1, "Native overlay must keep the captions HUD size")
            let oversized = SmokePanel(contentRect: NSRect(x: 40, y: 40, width: 1400, height: 1200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            constrainOverlayFrame(oversized)
            precondition(abs(oversized.frame.width - 576) < 1 && abs(oversized.frame.height - 190) < 1, "A restored fullscreen overlay must shrink to the captions HUD")
            var hud = smokeOverlay()
            hud["event"] = "overlay"
            hud["lines"] = [["id": "kn", "text": "ಕನ್ನಡ ಶೀರ್ಷಿಕೆ", "live": true]]
            hud["script"] = "indic"
            hud["targetLanguage"] = "kn"
            hud["targetLabel"] = "Kannada"
            Bridge.shared.receive(hud)
            await pause()
            precondition(OverlayModel.shared.snapshot?.lines.first?.text == "ಕನ್ನಡ ಶೀರ್ಷಿಕೆ", "Native overlay did not accept captions")
            precondition(overlayChrome != nil, "Native overlay host missing")
            let overlayShot = Process()
            overlayShot.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            overlayShot.arguments = ["-x", "-o", "-l", String(overlay.windowNumber), ProcessInfo.processInfo.environment["DOOT_SMOKE_OUTPUT"]! + "/Overlay.png"]
            try! overlayShot.run(); overlayShot.waitUntilExit()
            let wasActive = app.isActive
            let picker: JSON = ["key": "targetLanguage", "selected": "en", "choices": [["id": "auto", "label": "Auto detect"], ["id": "en", "label": "English"], ["id": "kn", "label": "Kannada"]], "x": 300, "y": 10, "width": 100, "height": 24]
            let pickerJSON = String(decoding: try! JSONSerialization.data(withJSONObject: picker), as: UTF8.self)
            pickerJSON.withCString { nativePicker(Unmanaged.passUnretained(overlay).toOpaque(), $0) }
            await pause()
            precondition(languagePopover?.isShown == true, "Native language picker did not open")
            precondition(app.isActive == wasActive, "Language picker activated the app")
            Bridge.shared.receive(["event": "session", "state": "starting"])
            await pause()
            precondition(languagePopover == nil, "Starting capture must dismiss language controls")
            overlay.orderOut(nil)
            print("Native smoke passed: every Settings page, preferences, login, multilingual history, cancel/delete, export cancellation, native overlay captions, and nonactivating language picker.")
            app.terminate(nil)
        }
        app.run()
    }
}
