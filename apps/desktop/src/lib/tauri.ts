import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CaptionEvent, SupportedLanguage } from "@doot/protocol";

export interface DesktopSession {
  sessionId: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  provider: string;
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
