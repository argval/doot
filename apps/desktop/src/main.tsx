import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { currentWindowLabel, isTauriRuntime } from "./lib/runtime";
import { SettingsApp } from "./settings/SettingsApp";
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

createRoot(root).render(
  <StrictMode>
    {windowLabel === "settings" ? <SettingsApp /> : <App />}
  </StrictMode>,
);
