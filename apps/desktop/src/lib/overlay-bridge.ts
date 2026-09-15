import { invoke } from "@tauri-apps/api/core";
import {
  LANGUAGE_LABELS,
  SUPPORTED_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  isSupportedLanguage,
  isSupportedTargetLanguage,
  type SupportedLanguage,
  type SupportedTargetLanguage,
} from "@doot/protocol";
import { captionScript } from "../overlay/CaptionPanel";
import { previewLinesFor, previewTargetLanguage } from "../overlay/preview";
import { isNativeMac } from "./native-ui";
import {
  CAPTION_FONT_SIZE_MAX,
  CAPTION_FONT_SIZE_MIN,
  OVERLAY_IDLE_OPACITY_MAX,
  OVERLAY_IDLE_OPACITY_MIN,
  type DesktopPrefs,
} from "./prefs";
import type { VisibleCaptionLine } from "../captions";

const LINE_LIMIT = 4;
const TEXT_LIMIT = 4000;
const CHOICE_LIMIT = 100;

export type OverlayChoice = { id: string; label: string };
export type OverlayPair = { source: string; target: string; label: string };
export type OverlayLine = { id: string; text: string; live: boolean; speaker?: number };

export type OverlaySnapshot = {
  lines: OverlayLine[];
  targetLanguage: string;
  sourceLanguage: string;
  script: "latin" | "indic" | "cjk" | "rtl";
  translating: boolean;
  capturing: boolean;
  transitioning: boolean;
  locked: boolean;
  error: string;
  notice: string;
  status: string;
  placeholder: string;
  announcement: string;
  audioLevel: number;
  listening: boolean;
  clickThrough: boolean;
  fontSize: number;
  idleOpacity: number;
  sourceLabel: string;
  targetLabel: string;
  captureHint: string;
  recent: OverlayPair[];
  sourceChoices: OverlayChoice[];
  targetChoices: OverlayChoice[];
};

export type OverlaySnapshotInput = {
  lines: readonly VisibleCaptionLine[];
  prefs: DesktopPrefs;
  capturing: boolean;
  transitioning: boolean;
  error: string;
  notice: string;
  status: string;
  placeholder: string;
  announcement: string;
  audioLevel: number;
  listening: boolean;
  clickThrough: boolean;
  captureHint: string;
};

let overlayCapture: (() => Promise<void>) | null = null;

export function registerOverlayCapture(action: (() => Promise<void>) | null): void {
  overlayCapture = action;
}

export function overlayCaptureAction(): () => Promise<void> {
  if (!overlayCapture) throw new Error("Overlay is not ready.");
  return overlayCapture;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function label(language: string): string {
  return LANGUAGE_LABELS[language as SupportedLanguage] ?? language;
}

function choices(languages: readonly SupportedLanguage[], allowAuto: boolean): OverlayChoice[] {
  const ids = allowAuto ? ["auto" as const, ...languages.filter((language) => language !== "auto")] : [...languages];
  return ids.slice(0, CHOICE_LIMIT).map((id) => ({ id, label: label(id) }));
}

export function sanitizeOverlaySnapshot(value: OverlaySnapshot): OverlaySnapshot {
  return {
    ...value,
    lines: value.lines.slice(0, LINE_LIMIT).map((line) => ({
      id: line.id.slice(0, 128),
      text: line.text.slice(0, TEXT_LIMIT),
      live: Boolean(line.live),
      speaker: line.speaker === 1 || line.speaker === 2 || line.speaker === 3 ? line.speaker : undefined,
    })),
    targetLanguage: value.targetLanguage.slice(0, 16),
    sourceLanguage: value.sourceLanguage.slice(0, 16),
    script: value.script,
    error: value.error.slice(0, 500),
    notice: value.notice.slice(0, 500),
    status: value.status.slice(0, 80),
    placeholder: value.placeholder.slice(0, 200),
    announcement: value.announcement.slice(0, TEXT_LIMIT),
    audioLevel: clamp(value.audioLevel, 0, 1),
    fontSize: Math.round(clamp(value.fontSize, CAPTION_FONT_SIZE_MIN, CAPTION_FONT_SIZE_MAX)),
    idleOpacity: clamp(value.idleOpacity, OVERLAY_IDLE_OPACITY_MIN, OVERLAY_IDLE_OPACITY_MAX),
    sourceLabel: value.sourceLabel.slice(0, 80),
    targetLabel: value.targetLabel.slice(0, 80),
    captureHint: value.captureHint.slice(0, 200),
    recent: value.recent.slice(0, 5).map((pair) => ({
      source: pair.source.slice(0, 16),
      target: pair.target.slice(0, 16),
      label: pair.label.slice(0, 120),
    })),
    sourceChoices: value.sourceChoices.slice(0, CHOICE_LIMIT),
    targetChoices: value.targetChoices.slice(0, CHOICE_LIMIT),
  };
}

function overlayScript(language: SupportedLanguage, text: string): OverlaySnapshot["script"] {
  if (language !== "auto") return captionScript(language);
  if (/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(text)) return "rtl";
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return "cjk";
  if (/[\u0900-\u0DFF]/u.test(text)) return "indic";
  return "latin";
}

export function liveOverlaySnapshot(input: OverlaySnapshotInput): OverlaySnapshot {
  const { prefs } = input;
  const sourceLanguages = SUPPORTED_LANGUAGES.filter((language) => language !== "auto");
  const text = input.lines.at(-1)?.translatedText ?? "";
  return sanitizeOverlaySnapshot({
    lines: input.lines.map((line) => ({
      id: line.utteranceId,
      text: line.translatedText,
      live: line.isActive,
      speaker: line.speakerTint,
    })),
    targetLanguage: prefs.targetLanguage,
    sourceLanguage: prefs.sourceLanguage,
    script: overlayScript(prefs.targetLanguage, text),
    translating: prefs.translateEnabled,
    capturing: input.capturing,
    transitioning: input.transitioning,
    locked: input.capturing || input.transitioning,
    error: input.error,
    notice: input.notice,
    status: input.status,
    placeholder: input.placeholder,
    announcement: input.announcement,
    audioLevel: input.audioLevel,
    listening: input.listening,
    clickThrough: input.clickThrough,
    fontSize: prefs.captionFontSize,
    idleOpacity: prefs.overlayIdleOpacity,
    sourceLabel: label(prefs.sourceLanguage),
    targetLabel: label(prefs.targetLanguage),
    captureHint: input.captureHint,
    recent: prefs.recentPairs.map((pair) => ({
      source: pair.source,
      target: pair.target,
      label: `${label(pair.source)} → ${label(pair.target)}`,
    })),
    sourceChoices: choices(sourceLanguages, true),
    targetChoices: choices(SUPPORTED_TARGET_LANGUAGES, !prefs.translateEnabled),
  });
}

export function settingsOverlayPreview(prefs: DesktopPrefs): OverlaySnapshot {
  const sample = previewTargetLanguage(prefs.targetLanguage);
  return liveOverlaySnapshot({
    lines: previewLinesFor(prefs.targetLanguage),
    prefs: { ...prefs, translateEnabled: true, sourceLanguage: "en", targetLanguage: sample },
    capturing: false,
    transitioning: false,
    error: "",
    notice: "",
    status: "",
    placeholder: "Your live captions will appear here.",
    announcement: "",
    audioLevel: 0,
    listening: false,
    clickThrough: false,
    captureHint: "Start capturing",
  });
}

export async function publishOverlay(snapshot: OverlaySnapshot): Promise<void> {
  if (!isNativeMac()) return;
  await invoke("native_ui_receive", { value: { event: "overlay", ...sanitizeOverlaySnapshot(snapshot) } });
}

export function overlayRecentPair(args: Record<string, unknown>): { source: SupportedLanguage; target: SupportedTargetLanguage } {
  const source = args.source;
  const target = args.target;
  if (typeof source !== "string" || !isSupportedLanguage(source) || typeof target !== "string" || !isSupportedTargetLanguage(target)) {
    throw new Error("Invalid language pair.");
  }
  return { source, target };
}
