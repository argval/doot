import AppKit

// Not linked into the app. check-native-ui.mjs compiles this to prove HUD
// conversion can keep NSWindow KVO observers intact.
final class Observer: NSObject {
    override func observeValue(forKeyPath keyPath: String?, of object: Any?, change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {}
}

@main private enum HudKvo {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 180), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let observer = Observer()
        window.addObserver(observer, forKeyPath: "contentLayoutRect", options: [.new], context: nil)
        window.addObserver(observer, forKeyPath: "titlebarAppearsTransparent", options: [.new], context: nil)
        let prevents = NSSelectorFromString("_setPreventsActivation:")
        precondition(window.responds(to: prevents), "AppKit is missing _setPreventsActivation:")
        window.perform(prevents, with: true)
        window.hidesOnDeactivate = false
        window.removeObserver(observer, forKeyPath: "contentLayoutRect")
        window.removeObserver(observer, forKeyPath: "titlebarAppearsTransparent")
        print("HUD KVO safety passed")
    }
}
