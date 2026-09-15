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
export const OVERLAY_IDLE_OPACITY_MIN = 0;
export const OVERLAY_IDLE_OPACITY_MAX = 1;
export const OVERLAY_HOVER_TINT = 0.12;
export const CONTEXT_HINT_MAX_CHARS = 80;

export interface DesktopPrefs {
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  translateEnabled: boolean;
  captionFontSize: number;
  overlayIdleOpacity: number;
  lastProvider: string | null;
  recentPairs: TranslationPair[];
  lastTranslationPair: TranslationPair;
  onboardingComplete: boolean;
  contextHint: string;
}

export interface TranslationPair { source: SupportedLanguage; target: SupportedTargetLanguage }

export const DEFAULT_PREFS: DesktopPrefs = {
  sourceLanguage: "auto",
  targetLanguage: "en",
  translateEnabled: true,
  captionFontSize: 28,
  overlayIdleOpacity: 0.42,
  lastProvider: null,
  recentPairs: [],
  lastTranslationPair: { source: "auto", target: "en" },
  onboardingComplete: false,
  contextHint: "",
};

const PREFS_FILE = "prefs.json";
const PREFS_KEY = "desktop";

let storePromise: Promise<Store> | null = null;
let memoryPrefs: DesktopPrefs = { ...DEFAULT_PREFS };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeContextHint(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PREFS.contextHint;
  return value.slice(0, CONTEXT_HINT_MAX_CHARS);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function hoverBoostFor(idleOpacity: number): number {
  const idle = overlayDimmingAlpha(idleOpacity);
  const hover = overlayDimmingAlpha(idleOpacity, true);
  if (idle >= 1) return 0;
  return (hover - idle) / (1 - idle);
}

/** Charcoal fill. 0 is clear, 1 is opaque. Matches overlayDimmingAlpha in DootOverlay.swift. */
export function overlayDimmingAlpha(idleOpacity: number, revealed = false): number {
  const idle = clamp(idleOpacity, OVERLAY_IDLE_OPACITY_MIN, OVERLAY_IDLE_OPACITY_MAX);
  return revealed ? Math.min(1, idle + OVERLAY_HOVER_TINT) : idle;
}

/** HUD frost peaks in the middle and is off at both clear and opaque. */
export function overlayVibrancyAlpha(idleOpacity: number, revealed = false): number {
  const fill = overlayDimmingAlpha(idleOpacity, revealed);
  return 4 * fill * (1 - fill);
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
  const lastProvider = typeof record.lastProvider === "string" && record.lastProvider.trim()
    ? record.lastProvider.trim()
    : null;

  const targetLanguage = translateEnabled
    ? concreteCaptionLanguage(rawTarget)
    : rawTarget;
  const validPair = (value: unknown): value is TranslationPair => {
    const pair = asRecord(value);
    return Boolean(pair && isSupportedLanguage(pair.source) && isSupportedTargetLanguage(pair.target));
  };
  const recentPairs = Array.isArray(record.recentPairs)
    ? record.recentPairs.filter(validPair).filter((pair, index, pairs) => pairs.findIndex((other) => other.source === pair.source && other.target === pair.target) === index).slice(0, 5)
    : [];
  const lastTranslationPair = validPair(record.lastTranslationPair)
    ? record.lastTranslationPair
    : { source: sourceLanguage, target: concreteCaptionLanguage(rawTarget) };

  return {
    sourceLanguage: translateEnabled ? sourceLanguage : targetLanguage,
    targetLanguage,
    translateEnabled,
    captionFontSize,
    overlayIdleOpacity,
    lastProvider,
    recentPairs,
    lastTranslationPair,
    onboardingComplete: record.onboardingComplete === true,
    contextHint: normalizeContextHint(record.contextHint),
  };
}

export function translationModePatch(prefs: DesktopPrefs): Partial<DesktopPrefs> {
  if (prefs.translateEnabled) return {
    translateEnabled: false,
    lastTranslationPair: { source: prefs.sourceLanguage, target: concreteCaptionLanguage(prefs.targetLanguage) },
    sourceLanguage: prefs.targetLanguage,
  };
  const pair = prefs.targetLanguage === "auto"
    ? { source: "auto" as const, target: "en" as const }
    : prefs.lastTranslationPair;
  return { translateEnabled: true, sourceLanguage: pair.source, targetLanguage: pair.target };
}

export function rememberPair(prefs: DesktopPrefs): TranslationPair[] {
  const pair = { source: prefs.sourceLanguage, target: concreteCaptionLanguage(prefs.targetLanguage) };
  return [pair, ...prefs.recentPairs.filter((other) => other.source !== pair.source || other.target !== pair.target)].slice(0, 5);
}

export function applyOverlayAppearance(prefs: DesktopPrefs): void {
  if (document.documentElement.classList.contains("settings-window")) {
    return;
  }
  const root = document.documentElement;
  const vibrancy = overlayVibrancyAlpha(prefs.overlayIdleOpacity);
  root.style.setProperty("--caption-font-size", `${prefs.captionFontSize}px`);
  root.style.setProperty("--overlay-idle-alpha", String(overlayDimmingAlpha(prefs.overlayIdleOpacity)));
  root.style.setProperty("--overlay-hover-boost", String(hoverBoostFor(prefs.overlayIdleOpacity)));
  root.style.setProperty("--overlay-vibrancy-alpha", String(vibrancy));
  root.style.setProperty("--overlay-frame-alpha", String(vibrancy));
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

let pendingPreferenceWrite: Promise<unknown> = Promise.resolve();

export function updatePrefs(patch: Partial<DesktopPrefs>): Promise<DesktopPrefs> {
  const write = pendingPreferenceWrite.then(async () => {
    const next = normalizePrefs({ ...(await loadPrefs()), ...patch });
    await savePrefs(next);
    if (isTauriRuntime()) {
      await emit(PREFS_CHANGED_EVENT, next);
    }
    return next;
  });
  pendingPreferenceWrite = write.catch(() => undefined);
  return write;
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
