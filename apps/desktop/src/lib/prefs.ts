import { emit, listen } from "@tauri-apps/api/event";
import { load, type Store } from "@tauri-apps/plugin-store";
import {
  isSupportedLanguage,
  isSupportedTargetLanguage,
  type SupportedLanguage,
  type SupportedTargetLanguage,
} from "@doot/protocol";
import { isTauriRuntime } from "./runtime";

export const PREFS_CHANGED_EVENT = "prefs://changed";
export const CAPTION_FONT_SIZE_MIN = 18;
export const CAPTION_FONT_SIZE_MAX = 40;
export const OVERLAY_IDLE_OPACITY_MIN = 0.18;
export const OVERLAY_IDLE_OPACITY_MAX = 0.7;

export interface DesktopPrefs {
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  translateEnabled: boolean;
  captionFontSize: number;
  overlayIdleOpacity: number;
  openAtLogin: boolean;
  lastProvider: string | null;
}

export const DEFAULT_PREFS: DesktopPrefs = {
  sourceLanguage: "auto",
  targetLanguage: "en",
  translateEnabled: true,
  captionFontSize: 28,
  overlayIdleOpacity: 0.42,
  openAtLogin: false,
  lastProvider: null,
};

const PREFS_FILE = "prefs.json";
const PREFS_KEY = "desktop";

let storePromise: Promise<Store> | null = null;
let memoryPrefs: DesktopPrefs = { ...DEFAULT_PREFS };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function hoverBoostFor(idleOpacity: number): number {
  return clamp(idleOpacity * 0.4 + 0.28, 0.2, 0.58);
}

/** Translate To cannot be Auto; fall back to English. */
export function concreteCaptionLanguage(
  language: SupportedLanguage,
): SupportedTargetLanguage {
  if (language === "auto" || !isSupportedTargetLanguage(language)) {
    return "en";
  }
  return language;
}

export function normalizePrefs(value: unknown): DesktopPrefs {
  const record = asRecord(value);
  if (!record) {
    return { ...DEFAULT_PREFS };
  }

  const sourceLanguage = isSupportedLanguage(record.sourceLanguage)
    ? record.sourceLanguage
    : DEFAULT_PREFS.sourceLanguage;
  const rawTarget = isSupportedLanguage(record.targetLanguage)
    ? record.targetLanguage
    : DEFAULT_PREFS.targetLanguage;
  const captionFontSize = typeof record.captionFontSize === "number"
    && Number.isFinite(record.captionFontSize)
    ? Math.round(clamp(record.captionFontSize, CAPTION_FONT_SIZE_MIN, CAPTION_FONT_SIZE_MAX))
    : DEFAULT_PREFS.captionFontSize;
  const overlayIdleOpacity = typeof record.overlayIdleOpacity === "number"
    && Number.isFinite(record.overlayIdleOpacity)
    ? clamp(record.overlayIdleOpacity, OVERLAY_IDLE_OPACITY_MIN, OVERLAY_IDLE_OPACITY_MAX)
    : DEFAULT_PREFS.overlayIdleOpacity;
  const translateEnabled = typeof record.translateEnabled === "boolean"
    ? record.translateEnabled
    : DEFAULT_PREFS.translateEnabled;
  const openAtLogin = typeof record.openAtLogin === "boolean"
    ? record.openAtLogin
    : DEFAULT_PREFS.openAtLogin;
  const lastProvider = typeof record.lastProvider === "string" && record.lastProvider.trim()
    ? record.lastProvider.trim()
    : null;

  const targetLanguage = translateEnabled
    ? concreteCaptionLanguage(rawTarget)
    : rawTarget;

  return {
    sourceLanguage: translateEnabled ? sourceLanguage : targetLanguage,
    targetLanguage,
    translateEnabled,
    captionFontSize,
    overlayIdleOpacity,
    openAtLogin,
    lastProvider,
  };
}

export function applyOverlayAppearance(prefs: DesktopPrefs): void {
  if (document.documentElement.classList.contains("settings-window")) {
    return;
  }
  const root = document.documentElement;
  root.style.setProperty("--caption-font-size", `${prefs.captionFontSize}px`);
  root.style.setProperty("--overlay-idle-alpha", String(prefs.overlayIdleOpacity));
  root.style.setProperty("--overlay-hover-boost", String(hoverBoostFor(prefs.overlayIdleOpacity)));
}

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = load(PREFS_FILE, { autoSave: true });
  }
  return storePromise;
}

export async function loadPrefs(): Promise<DesktopPrefs> {
  if (!isTauriRuntime()) {
    return { ...memoryPrefs };
  }
  try {
    const store = await getStore();
    const raw = await store.get<unknown>(PREFS_KEY);
    memoryPrefs = normalizePrefs(raw);
    return { ...memoryPrefs };
  } catch {
    memoryPrefs = { ...DEFAULT_PREFS };
    return { ...memoryPrefs };
  }
}

export async function savePrefs(prefs: DesktopPrefs): Promise<void> {
  memoryPrefs = normalizePrefs(prefs);
  if (!isTauriRuntime()) {
    return;
  }
  const store = await getStore();
  await store.set(PREFS_KEY, memoryPrefs);
  await store.save();
}

export async function updatePrefs(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs> {
  const next = normalizePrefs({ ...(await loadPrefs()), ...patch });
  await savePrefs(next);
  if (isTauriRuntime()) {
    await emit(PREFS_CHANGED_EVENT, next);
  }
  return next;
}

export async function subscribeToPrefs(
  handler: (prefs: DesktopPrefs) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  return listen<DesktopPrefs>(PREFS_CHANGED_EVENT, (event) => {
    handler(normalizePrefs(event.payload));
  });
}
