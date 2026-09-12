import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isProviderId, isSupportedLanguage, type CaptionEvent, type CaptionRoute, type SupportedLanguage } from "@doot/protocol";
import { gatewayFetch } from "./gateway";

export interface DesktopSession {
  sessionId: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  provider: string;
}

export interface SessionStatus {
  state: "idle" | "starting" | "capturing" | "reconnecting" | "finalizing" | "warning" | "error";
  sessionId?: string;
  message?: string;
  code?: string;
}

export async function startCaptionSession(
  sourceLanguage: SupportedLanguage,
  targetLanguage: SupportedLanguage,
): Promise<DesktopSession> {
  await getCaptionRoute(sourceLanguage, targetLanguage);
  return invoke<DesktopSession>("start_caption_session", { sourceLanguage, targetLanguage });
}

export async function getCaptionRoute(
  source: SupportedLanguage,
  target: SupportedLanguage,
): Promise<CaptionRoute> {
  let response: Response;
  try {
    response = await gatewayFetch(`/v1/route?${new URLSearchParams({ source, target })}`, {
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    throw new Error("Caption service could not start. Open Settings to check service setup.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null) throw new Error("Caption service returned an invalid route.");
  if (!response.ok) throw new Error("message" in body && typeof body.message === "string" ? body.message : "This caption route is unavailable.");
  if (!("speechProvider" in body) || !isProviderId(body.speechProvider)
    || !("mode" in body) || (body.mode !== "transcribe" && body.mode !== "translate")
    || !("translation" in body) || !["none", "native", "text"].includes(String(body.translation))
    || !("translationProvider" in body) || (body.translationProvider !== null && typeof body.translationProvider !== "string")
    || !("description" in body) || typeof body.description !== "string"
    || !("detectionLanguages" in body) || !Array.isArray(body.detectionLanguages)
    || !body.detectionLanguages.every(isSupportedLanguage)) {
    throw new Error("Caption service returned an invalid route.");
  }
  return body as CaptionRoute;
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

export interface AudioActivity { sessionId: string; level: number; silentForMs: number; droppedAudioMs?: number }
export function subscribeToAudioActivity(handler: (activity: AudioActivity) => void): Promise<() => void> {
  return listen<AudioActivity>("caption://audio", (event) => handler(event.payload));
}

export async function openAudioSettings(): Promise<void> {
  return invoke("open_audio_settings");
}

export interface AudioCaptureStatus {
  state: string;
  backend: string;
  sampleRate: number;
  channels: number;
}

export interface ConnectionStatus {
  gatewayReachable: boolean;
  capture: AudioCaptureStatus;
  lastProvider: string | null;
  audioPermission: "granted" | "required" | "not-required";
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const [native, reachable] = await Promise.all([
    invoke<Omit<ConnectionStatus, "gatewayReachable">>("connection_status"),
    gatewayFetch("/health").then((response) => response.ok, () => false),
  ]);
  return { ...native, gatewayReachable: reachable };
}

export async function openSettingsWindow(): Promise<void> {
  return invoke("open_settings_window");
}
