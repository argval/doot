# Doot

Doot is a cross-platform desktop application for live captions and translation of audio playing on a computer. The project is deliberately split into a native desktop engine, a replaceable provider layer, and a small realtime gateway.

The current repository is a runnable skeleton. The UI, command/event boundaries, WebSocket protocol, provider routing, and database schema are present. OS audio capture and vendor streaming adapters are explicit implementation seams and return clear scaffold errors until their platform permissions and SDK wiring are added.

## Architecture

```text
apps/desktop
  React + TypeScript + Vite
        │ Tauri commands/events
  Rust audio engine
    ├─ ScreenCaptureKit capture / WASAPI seam
    ├─ provider router
    └─ caption session state
        │ bounded PCM chunks over WebSocket
services/gateway
  Fastify + @fastify/websocket
    ├─ session lifecycle
    ├─ provider selection
    └─ bounded PCM chunk handling seam
        │
packages/protocol       Shared client/server message types
packages/db             Drizzle schema and local Turso (SQLite) client
infra                    Notes for a later production gateway layout
```

## Prerequisites

- Node.js 20 or newer and npm 10 or newer.
- Rust stable and Cargo.
- Tauri 2 system prerequisites for your operating system. Follow the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- macOS 14 or newer for the current ScreenCaptureKit implementation.
- Optional: `npm run db:migrate` creates a local Turso SQLite file (no Docker).

On macOS, the eventual ScreenCaptureKit implementation will need Screen Recording permission. On Windows, the WASAPI loopback implementation will use the default render endpoint and does not require microphone permission for system audio.

## Bootstrap

```bash
npm install
npm run setup
npm run db:migrate
```

No API key is needed to inspect the UI or exercise the mock caption path. For live captions, set `SARVAM_API_KEY` and/or `GEMINI_API_KEY` in the repo-root `.env` (see `.env.example`). Sarvam handles English and Indic speech; Gemini Live Translate handles other spoken languages. Text translation uses Sarvam for Indic pairs and Gemini text MT for everything else (so English→Spanish/French stays on Sarvam STT plus Gemini MT).

## Run locally

Start the complete local development environment:

```bash
npm run dev
# or
./scripts/dev.sh
```

This opens the native Doot desktop app and starts the gateway. The gateway exposes:

- `GET http://127.0.0.1:8787/health`
- `ws://127.0.0.1:8787/v1/realtime`

To work on the browser UI without Tauri:

```bash
npm run dev:web
```

To run the gateway separately:

```bash
npm run dev:gateway
```

`npm run dev:tauri` starts both the native desktop app and its local gateway. If
you launch the native desktop process by another route, start
`npm run dev:gateway` alongside it.

On macOS, start and stop capture from the overlay, the tray menu, or with `Cmd+Shift+D`. The first capture prompts for **Screen & System Audio Recording** permission. With `SARVAM_API_KEY` set, English and supported Indic-language routes use Sarvam Realtime with automatic legacy-streaming failover. Translation is routed independently: Indic pairs use Sarvam (`TRANSLATION_API_KEY` can hold a separate Sarvam translation key and otherwise falls back to `SARVAM_API_KEY`); other pairs use Gemini text translation when `GEMINI_API_KEY` is set.

With `GEMINI_API_KEY` set, non-Indic spoken sources (Spanish, French, German, Japanese, and the rest of Gemini Live Translate's set) route through `gemini-3.5-live-translate-preview`. Gemini's source and translated transcripts are correlated inside one provider session and bypass the separate text translator. Auto detect uses Sarvam when the target is English or Indic, and Gemini when the target is another international language. English→Spanish and similar pairs keep Sarvam speech recognition and Gemini text MT unless the benchmark client requests `--provider gemini`.

Windows still returns the explicit WASAPI scaffold error. Other platforms retain the stub backend for session-state development.

## Useful checks

```bash
npm run typecheck
npm run build
npm run test
npm run lint --workspace @doot/desktop
npm run db:generate
npm run db:migrate
npm run build:tauri
```

## Live translation benchmark

The benchmark runner accepts raw PCM S16LE audio at 16 kHz mono, streams it at the same 100 ms cadence as the desktop, and prints JSON with first-caption/final-caption latency, revision count, provider errors, disconnects, final translation, and Gemini's estimated audio cost.

```bash
# Prepare a representative clip.
ffmpeg -i spanish-football.wav -ac 1 -ar 16000 -f s16le spanish-football.pcm

# In another terminal, run the configured gateway.
npm run dev:gateway

# Benchmark Gemini. Change source/target/provider for each comparison lane.
npm run benchmark:live -- \
  --audio spanish-football.pcm \
  --source es \
  --target en \
  --provider gemini \
  --quality-notes "Manual translation assessment"
```

Use representative clips for Spanish→English, French→English, German→English, English→Spanish, and English→Hindi. Run English→Hindi once with `--provider gemini` and once with `--provider sarvam`. The POC does not make external API calls during automated tests.

## Protocol

The shared protocol lives in `packages/protocol/src/index.ts`. A client first sends `start_session`, then sends base64-encoded PCM S16LE `audio_chunk` messages, and finally sends `stop_session`.

```json
{
  "type": "start_session",
  "sessionId": "session-id",
  "sourceLanguage": "hi",
  "targetLanguage": "en",
  "sampleRate": 16000,
  "channels": 1
}
```

The gateway responds with `session_started`, followed by `caption` events. Without an explicit provider, Sarvam remains preferred for English/Indic speech (including English→Spanish via Gemini text MT), Gemini Live Translate handles other spoken-language sources, and Auto uses Sarvam for English/Indic targets and Gemini otherwise. Sarvam source transcripts use the independent text-translation router; Gemini emits provider-native translated revisions through the same caption stabilizer.

Provider-specific code is local to its directory under `services/gateway/src/speech/`. A new speech model implements the small interface in `services/gateway/src/speech/contract.ts` and adds one construction entry in `services/gateway/src/speech/registry.ts`; health reporting and routing derive from that registry. Translation providers follow the equivalent contract/router/registry seam under `services/gateway/src/translation/`.

## Where to implement the next pieces

1. **Provider benchmarks:** measure Sarvam against representative desktop audio, tracking WER, partial latency, final latency, translation quality, and cost.
2. **Caption persistence:** insert finalized segments through `@doot/db`; keep partial captions in memory only.
3. **Windows capture:** replace the `WasapiBackend` error path with a COM/WASAPI loopback client and endpoint format conversion.
4. **Production stream lifecycle:** add explicit backpressure telemetry and provider-level health measurements.

## Design decisions

- **Tauri 2 + Rust:** native audio and OS integration belong beside the UI, while React keeps the overlay easy to iterate on.
- **Provider modules:** Sarvam owns English/Indic speech and Indic text translation. Gemini Live Translate covers international speech; Gemini text MT covers non-Indic pairs from Sarvam transcripts.
- **WebSocket gateway:** streaming audio and partial captions need a long-lived, bidirectional connection. The gateway is intentionally stateless beyond each socket for the first version.
- **Drizzle + Turso:** sessions and finalized caption segments live in a local SQLite file (Rust-rewritten engine) without forcing persistence into the live audio path.
- **Explicit platform stubs:** platform capture code is isolated behind a trait so macOS, Windows, and a future Linux backend can evolve independently.

## Current limitations

- Native system-audio capture is implemented on macOS only.
- Sarvam Realtime STT is wired for English and Indic-language routes with legacy-streaming failover.
- Gemini Live Translate covers Gemini's international language matrix for non-Indic spoken sources; it has no cross-provider failover yet.
- Progressive translated captions use Sarvam's text-translation API for English/Indic pairs and Gemini text MT for other pairs; unsupported pairs return a translation error and never display source text as translated text.
- Finalized captions are not persisted yet.
- Authentication, rate limiting, billing, and production secrets management are intentionally out of scope for this skeleton.
