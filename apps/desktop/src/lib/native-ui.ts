import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";

function hostPlatform(): string {
  const hints = navigator as Navigator & { userAgentData?: { platform?: string } };
  return `${hints.platform ?? ""} ${hints.userAgent ?? ""} ${hints.userAgentData?.platform ?? ""}`.toLowerCase();
}

export function isMacHost(): boolean {
  const host = hostPlatform();
  return host.includes("mac") || host.includes("iphone") || host.includes("ipad");
}

export function isNativeMac(): boolean {
  return isTauriRuntime() && isMacHost();
}

export async function confirmDestructive(title: string, message: string, action: string): Promise<boolean> {
  if (!isTauriRuntime()) return window.confirm(`${title}\n\n${message}`);
  return invoke<boolean>("confirm_destructive", { title, message, action });
}
