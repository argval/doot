use tauri::WebviewWindow;

/// NSWindowStyleMaskNonactivatingPanel. Only meaningful on NSPanel.
pub const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: usize = 1 << 7;
/// WS_EX_NOACTIVATE — clicks do not make the overlay the foreground window.
pub const WS_EX_NOACTIVATE: u32 = 0x0800_0000;

pub fn apply_overlay_chrome(window: &WebviewWindow) {
    apply_nonactivating_hud(window);
    apply_overlay_vibrancy(window);
}

pub fn show_overlay_without_activating(window: &WebviewWindow) {
    apply_overlay_chrome(window);
    let _ = window.set_always_on_top(true);
    #[cfg(target_os = "macos")]
    let _ = window.set_visible_on_all_workspaces(true);
    let _ = window.unminimize();
    #[cfg(target_os = "macos")]
    macos::order_front_regardless(window);
    #[cfg(target_os = "windows")]
    windows::show_without_activating(window);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = window.show();
}

fn apply_nonactivating_hud(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    macos::convert_to_hud_panel(window);
    #[cfg(target_os = "windows")]
    windows::apply_ws_ex_noactivate(window);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = window;
}

fn apply_overlay_vibrancy(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        let _ = window.set_effects(
            EffectsBuilder::new()
                .effect(Effect::HudWindow)
                .state(EffectState::Active)
                .radius(16.0)
                .build(),
        );
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(target_os = "macos")]
mod macos {
    use super::NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL;
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use std::sync::OnceLock;
    use tauri::WebviewWindow;

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    #[link(name = "objc")]
    extern "C" {
        fn class_getInstanceSize(cls: *const AnyClass) -> usize;
        fn class_getSuperclass(cls: *const AnyClass) -> *const AnyClass;
    }

    pub fn convert_to_hud_panel(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else {
            return;
        };
        let ptr = ptr.cast::<AnyObject>();
        if ptr.is_null() {
            return;
        }
        let obj = unsafe { &*ptr };
        let hud = hud_panel_class(obj.class());
        if !std::ptr::eq(obj.class(), hud) {
            // SAFETY: DootHudPanel adds no ivars. Superclass is NSPanel when
            // instance sizes match, otherwise the live window class.
            let _previous = unsafe { AnyObject::set_class(obj, hud) };
        }
        apply_panel_style(obj);
    }

    pub fn order_front_regardless(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else {
            let _ = window.show();
            return;
        };
        let ptr = ptr.cast::<AnyObject>();
        if ptr.is_null() {
            let _ = window.show();
            return;
        }
        let obj = unsafe { &*ptr };
        let _: () = unsafe { msg_send![obj, orderFrontRegardless] };
    }

    fn hud_panel_class(current: &'static AnyClass) -> &'static AnyClass {
        static CLASS: OnceLock<&'static AnyClass> = OnceLock::new();
        *CLASS.get_or_init(|| register_hud_panel_class(current))
    }

    fn register_hud_panel_class(current: &'static AnyClass) -> &'static AnyClass {
        if let Some(existing) = AnyClass::get(c"DootHudPanel") {
            return existing;
        }
        let superclass = panel_superclass(current);
        let Some(mut builder) = ClassBuilder::new(c"DootHudPanel", superclass) else {
            return AnyClass::get(c"DootHudPanel").unwrap_or(superclass);
        };
        unsafe {
            builder.add_method(
                sel!(canBecomeKeyWindow),
                can_become_key as unsafe extern "C-unwind" fn(_, _) -> _,
            );
            builder.add_method(
                sel!(canBecomeMainWindow),
                cannot_become_main as unsafe extern "C-unwind" fn(_, _) -> _,
            );
        }
        builder.register()
    }

    fn panel_superclass(current: &'static AnyClass) -> &'static AnyClass {
        let Some(panel) = AnyClass::get(c"NSPanel") else {
            return current;
        };
        if class_is_kind_of(current, panel) || instance_size(current) == instance_size(panel) {
            panel
        } else {
            current
        }
    }

    fn apply_panel_style(obj: &AnyObject) {
        unsafe {
            let style: usize = msg_send![obj, styleMask];
            let _: () =
                msg_send![obj, setStyleMask: style | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL];
            let _: () = msg_send![obj, setHidesOnDeactivate: Bool::new(false)];
            let _: () = msg_send![obj, setReleasedWhenClosed: Bool::new(false)];
            if responds(obj, sel!(setFloatingPanel:)) {
                let _: () = msg_send![obj, setFloatingPanel: Bool::new(true)];
            }
            if responds(obj, sel!(setBecomesKeyOnlyIfNeeded:)) {
                let _: () = msg_send![obj, setBecomesKeyOnlyIfNeeded: Bool::new(true)];
            }
        }
    }

    fn responds(obj: &AnyObject, selector: Sel) -> bool {
        let value: Bool = unsafe { msg_send![obj, respondsToSelector: selector] };
        value.as_bool()
    }

    fn instance_size(cls: &AnyClass) -> usize {
        unsafe { class_getInstanceSize(cls) }
    }

    fn class_is_kind_of(cls: &AnyClass, ancestor: &AnyClass) -> bool {
        let mut cursor: *const AnyClass = cls;
        while !cursor.is_null() {
            if std::ptr::eq(cursor, ancestor) {
                return true;
            }
            cursor = unsafe { class_getSuperclass(cursor) };
        }
        false
    }

    unsafe extern "C-unwind" fn can_become_key(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::new(true)
    }

    unsafe extern "C-unwind" fn cannot_become_main(_this: &AnyObject, _cmd: Sel) -> Bool {
        Bool::new(false)
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOPMOST,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_SHOWNOACTIVATE,
    };

    pub fn apply_ws_ex_noactivate(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        set_no_activate(hwnd);
    }

    pub fn show_without_activating(window: &WebviewWindow) {
        let Ok(hwnd) = window.hwnd() else {
            let _ = window.show();
            return;
        };
        set_no_activate(hwnd);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    fn set_no_activate(hwnd: HWND) {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | super::WS_EX_NOACTIVATE as isize);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL, WS_EX_NOACTIVATE};

    #[test]
    fn nonactivating_panel_mask_matches_appkit() {
        assert_eq!(NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL, 128);
    }

    #[test]
    fn ws_ex_noactivate_matches_winuser() {
        assert_eq!(WS_EX_NOACTIVATE, 0x0800_0000);
    }
}
