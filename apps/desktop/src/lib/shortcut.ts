export function captureShortcutLabel(): string {
  const platform = navigator.platform.toLowerCase();
  return platform.includes("mac") ? "⌘⇧D" : "Ctrl+Shift+D";
}
