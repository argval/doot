import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { currentWindowLabel, isTauriRuntime } from "./lib/runtime";
import { SettingsApp } from "./settings/SettingsApp";
import { isMacHost, isNativeMac } from "./lib/native-ui";
import "./tokens.css";
import "./styles.css";
import "./settings/settings.css";

function resolveWindowLabel(): string {
  if (isTauriRuntime()) {
    return currentWindowLabel();
  }
  const requested = new URLSearchParams(window.location.search).get("window");
  return requested === "settings" ? "settings" : "main";
}

const windowLabel = resolveWindowLabel();
document.documentElement.dataset.runtime = isTauriRuntime() ? "tauri" : "web";
const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
document.documentElement.dataset.os = isMacHost()
  ? "mac"
  : platform.includes("win")
    ? "win"
    : "linux";
if (windowLabel === "settings") {
  document.documentElement.classList.add("settings-window");
  document.body.classList.add("settings-window");
} else if (!isTauriRuntime()) {
  document.documentElement.classList.add("web-preview");
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Doot UI root element is missing");
}

async function mount() {
  if (windowLabel === "main" && isNativeMac()) {
    const { startNativeSettingsBridge } = await import("./lib/native-settings");
    await startNativeSettingsBridge();
  }
  createRoot(root!).render(
    <StrictMode>
      {windowLabel === "settings" ? <SettingsApp /> : <App />}
    </StrictMode>,
  );
}
void mount();
