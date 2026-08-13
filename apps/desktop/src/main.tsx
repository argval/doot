import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { currentWindowLabel } from "./lib/runtime";
import { SettingsApp } from "./settings/SettingsApp";
import "./styles.css";
import "./settings/settings.css";

const windowLabel = currentWindowLabel();
if (windowLabel === "settings") {
  document.documentElement.classList.add("settings-window");
  document.body.classList.add("settings-window");
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
