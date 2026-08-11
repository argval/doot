import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  isProviderId,
  isSupportedLanguage,
  isSupportedTargetLanguage,
  type CaptionEvent,
  type ProviderId,
  type ServerMessage,
  type SupportedLanguage,
  type SupportedTargetLanguage,
} from "@doot/protocol";
import WebSocket from "ws";

const FRAME_BYTES = 3_200;
const FRAME_MS = 100;
const GEMINI_EFFECTIVE_COST_PER_MINUTE_USD = 0.0368;

interface BenchmarkOptions {
  audioPath: string;
  source: SupportedLanguage;
  target: SupportedTargetLanguage;
  provider: ProviderId;
  gatewayUrl: string;
  qualityNotes?: string;
}

interface BenchmarkResult {
  source: SupportedLanguage;
  target: SupportedTargetLanguage;
  providerRequested: ProviderId;
  providerSelected: ProviderId | null;
  audioDurationMs: number;
  firstTranslatedCaptionLatencyMs: number | null;
  finalCaptionLatencyMs: number | null;
  captionRevisions: number;
  finalTranslation: string;
  providerErrors: string[];
  disconnectCount: number;
  estimatedGeminiCostUsd: number | null;
  qualityNotes?: string;
}

const options = parseOptions(process.argv.slice(2));
const audio = await readFile(options.audioPath);
if (audio.byteLength === 0 || audio.byteLength % 2 !== 0) {
  throw new Error("Benchmark audio must contain complete PCM16 samples");
}

const result = await runBenchmark(options, audio);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.finalTranslation) process.exitCode = 2;

function runBenchmark(options: BenchmarkOptions, audio: Buffer): Promise<BenchmarkResult> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(options.gatewayUrl);
    const sessionId = `benchmark-${Date.now()}`;
    const durationMs = Math.round(audio.byteLength / 32);
    const timeout = setTimeout(() => finishError(new Error("Benchmark timed out")), durationMs + 60_000);
    const captions: CaptionEvent[] = [];
    const providerErrors: string[] = [];
    let providerSelected: ProviderId | null = null;
    let startedAt: number | null = null;
    let firstTranslatedAt: number | null = null;
    let finalCaptionAt: number | null = null;
    let disconnectCount = 0;
    let finished = false;

    const finishError = (error: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.terminate();
      reject(error);
    };
    const finishSuccess = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      socket.close();
      const finalCaption = [...captions].reverse().find((caption) => caption.isFinal);
      const estimatedCost = options.provider === "gemini"
        ? Number(((durationMs / 60_000) * GEMINI_EFFECTIVE_COST_PER_MINUTE_USD).toFixed(6))
        : null;
      resolve({
        source: options.source,
        target: options.target,
        providerRequested: options.provider,
        providerSelected,
        audioDurationMs: durationMs,
        firstTranslatedCaptionLatencyMs: elapsed(startedAt, firstTranslatedAt),
        finalCaptionLatencyMs: elapsed(startedAt, finalCaptionAt),
        captionRevisions: captions.length,
        finalTranslation: finalCaption?.translatedText ?? "",
        providerErrors,
        disconnectCount,
        estimatedGeminiCostUsd: estimatedCost,
        ...(options.qualityNotes ? { qualityNotes: options.qualityNotes } : {}),
      });
    };

    socket.once("error", finishError);
    socket.once("close", () => {
      if (!finished) {
        disconnectCount += 1;
        finishError(new Error("Gateway disconnected before the benchmark completed"));
      }
    });
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "start_session",
        sessionId,
        sourceLanguage: options.source,
        targetLanguage: options.target,
        provider: options.provider,
        sampleRate: 16_000,
        channels: 1,
      }));
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === "session_started") {
        providerSelected = message.provider;
        startedAt = performance.now();
        void streamAudio(socket, sessionId, audio).catch(finishError);
        return;
      }
      if (message.type === "caption") {
        captions.push(message);
        if (message.translatedText && firstTranslatedAt === null) {
          firstTranslatedAt = performance.now();
        }
        if (message.isFinal) finalCaptionAt = performance.now();
        return;
      }
      if (message.type === "error") {
        providerErrors.push(`${message.code}: ${message.message}`);
        if (/disconnect|connection closed/i.test(message.message)) {
          disconnectCount += 1;
        }
        if (!providerSelected && message.code === "PROVIDER_UNAVAILABLE") {
          finishError(new Error(message.message));
        }
        return;
      }
      if (message.type === "session_stopped") finishSuccess();
    });
  });
}

async function streamAudio(socket: WebSocket, sessionId: string, audio: Buffer): Promise<void> {
  let sequence = 0;
  for (let offset = 0; offset < audio.byteLength; offset += FRAME_BYTES) {
    const chunk = audio.subarray(offset, Math.min(offset + FRAME_BYTES, audio.byteLength));
    socket.send(JSON.stringify({
      type: "audio_chunk",
      sessionId,
      sequence,
      timestampMs: sequence * FRAME_MS,
      encoding: "pcm_s16le",
      dataBase64: chunk.toString("base64"),
    }));
    sequence += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, FRAME_MS));
  }
  socket.send(JSON.stringify({ type: "stop_session", sessionId }));
}

function parseOptions(args: string[]): BenchmarkOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) usage();
    values.set(key.slice(2), value);
  }

  const audioPath = values.get("audio");
  const source = values.get("source");
  const target = values.get("target");
  const provider = values.get("provider");
  if (
    !audioPath
    || !isSupportedLanguage(source)
    || !isSupportedTargetLanguage(target)
    || !isProviderId(provider)
  ) usage();

  return {
    audioPath,
    source,
    target,
    provider,
    gatewayUrl: values.get("gateway") ?? "ws://127.0.0.1:8787/v1/realtime",
    ...(values.get("quality-notes")
      ? { qualityNotes: values.get("quality-notes") }
      : {}),
  };
}

function usage(): never {
  throw new Error(
    "Usage: npm run benchmark:live -- --audio sample.pcm --source es --target en "
    + "--provider gemini [--quality-notes \"manual assessment\"]",
  );
}

function elapsed(start: number | null, end: number | null): number | null {
  return start === null || end === null ? null : Math.round(end - start);
}
