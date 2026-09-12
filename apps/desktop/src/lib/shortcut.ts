export function captureShortcutLabel(): string {
  const platform = navigator.platform.toLowerCase();
  return platform.includes("mac") ? "⌘⇧D" : "Ctrl+Shift+D";
}

export function interactionShortcutLabel(): string {
  return navigator.platform.toLowerCase().includes("mac") ? "⌘⇧O" : "Ctrl+Shift+O";
}
