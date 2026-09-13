export interface NativeCaptionTiming { nativeReceivedAtMs: number; audioLagMs: number | null }
export interface CaptionTimingSample { provider: string; final: boolean; pipelineMs: number; desktopMs: number; estimatedDisplayLagMs: number }

export interface TranslationTimingSample {
  speechProvider: string;
  translationProvider: string;
  sourceLanguage: string;
  targetLanguage: string;
  urgency: "draft" | "final";
  outcome: "success" | "error" | "timeout" | "cancelled" | "reused";
  queueMs: number;
  requestMs: number | null;
  sourceToCompleteMs: number;
  completionToCaptionMs: number | null;
}

export function captionTimingSample(provider: string, final: boolean, timing: NativeCaptionTiming | undefined, paintedAtMs: number): CaptionTimingSample | null {
  if (!timing || timing.audioLagMs === null) return null;
  const desktopMs = paintedAtMs - timing.nativeReceivedAtMs;
  // Same-computer wall clocks bridge native and WebView; reject clock adjustments.
  if (![desktopMs, timing.audioLagMs].every((value) => Number.isFinite(value) && value >= 0 && value <= 60_000)) return null;
  return { provider, final, pipelineMs: timing.audioLagMs, desktopMs, estimatedDisplayLagMs: timing.audioLagMs + desktopMs };
}

export function summarizeTiming(samples: CaptionTimingSample[], field: "pipelineMs" | "desktopMs" | "estimatedDisplayLagMs") {
  return summarizeMilliseconds(samples.map((sample) => sample[field]));
}

export function summarizeMilliseconds(values: Array<number | null>) {
  const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * p) - 1]!) : null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95) };
}
