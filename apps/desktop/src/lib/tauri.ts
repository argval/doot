import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CaptionEvent, SupportedLanguage } from "@doot/protocol";

export interface DesktopSession {
  sessionId: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  provider: string;
}

export interface SessionStatus {
  state: "idle" | "capturing" | "warning" | "error";
  sessionId?: string;
  message?: string;
}

export async function startCaptionSession(
  sourceLanguage: SupportedLanguage,
  targetLanguage: SupportedLanguage,
): Promise<DesktopSession> {
  return invoke<DesktopSession>("start_caption_session", { sourceLanguage, targetLanguage });
}

export async function stopCaptionSession(sessionId: string): Promise<void> {
  return invoke("stop_caption_session", { sessionId });
}

export function subscribeToCaptions(handler: (event: CaptionEvent) => void): Promise<() => void> {
  return listen<CaptionEvent>("caption://segment", (event) => handler(event.payload));
}

export function subscribeToSessionStatus(handler: (status: SessionStatus) => void): Promise<() => void> {
  return listen<SessionStatus>("caption://status", (event) => handler(event.payload));
}

export function subscribeToCaptureToggle(handler: () => void): Promise<() => void> {
  return listen("caption://toggle-request", handler);
}
