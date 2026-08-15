# Doot

Doot is a cross-platform desktop application for live captions and translation of audio playing on a computer. The project is deliberately split into a native desktop engine, a replaceable provider layer, and a small realtime gateway.

The UI, command/event boundaries, WebSocket protocol, provider routing, and database schema are present. Native system-audio capture is implemented on macOS (ScreenCaptureKit) and Windows (WASAPI loopback). Other platforms keep a stub backend for session-state development.

## Architecture

```text
apps/desktop
  React + TypeScript + Vite
        │ Tauri commands/events
  Rust audio engine
    ├─ ScreenCaptureKit (macOS) / WASAPI loopback (Windows)
    ├─ shared PCM convert → 16 kHz mono S16LE
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
- macOS 14 or newer for ScreenCaptureKit capture.
- Windows 10 version 1903 or newer (or Windows 11), plus WebView2 and the MSVC build tools, for WASAPI capture and the Tauri app.
- The gateway migrates its local Turso SQLite file on startup (no Docker). Run `npm run db:migrate` directly to verify it manually.

On macOS, ScreenCaptureKit needs **Screen & System Audio Recording** permission. On Windows, WASAPI loopback uses the default playback device and does not require microphone permission. Exclusive-mode audio (some games, ASIO) is not visible to shared-mode loopback.

## Bootstrap

```bash
npm install
npm run setup
```

No API key is needed to inspect the UI or exercise the mock caption path. For live captions, set `SARVAM_API_KEY` and/or `GEMINI_API_KEY` in the repo-root `.env` (see `.env.example`). Sarvam handles English and Indic speech; Gemini Live Translate handles other spoken languages. Text translation uses Sarvam for Indic pairs and Gemini text MT for everything else (so English→Spanish/French stays on Sarvam STT plus Gemini MT).

## Run locally

Start the complete local development environment:

```bash
bun run dev
```

On Windows, use `bun run dev` from the repo root. This opens the native Doot desktop app and starts the gateway. The gateway exposes:

- `GET http://127.0.0.1:8787/health`
- `GET http://127.0.0.1:8787/v1/history/sessions`
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

Start and stop capture from the overlay, the tray menu, or the global shortcut (`Cmd+Shift+D` on macOS, `Ctrl+Shift+D` on Windows). On macOS the first capture prompts for **Screen & System Audio Recording** permission. With `SARVAM_API_KEY` set, English and supported Indic-language routes use Sarvam Realtime. Translation is routed independently: Indic pairs use Sarvam; other pairs use Gemini text translation when `GEMINI_API_KEY` is set.

With `GEMINI_API_KEY` set, non-Indic spoken sources (Spanish, French, German, Japanese, and the rest of Gemini Live Translate's set) route through `gemini-3.5-live-translate-preview`. Gemini's source and translated transcripts are correlated inside one provider session and bypass the separate text translator. Auto detect uses Sarvam when the target is English or Indic, and Gemini when the target is another international language. English→Spanish and similar pairs keep Sarvam speech recognition and Gemini text MT unless the benchmark client requests `--provider gemini`.

Linux and other non-macOS/non-Windows hosts retain the stub capture backend for session-state development.

## Useful checks

```bash
npm run typecheck
npm run build
npm run test
npm run lint --workspace @doot/desktop
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
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

Provider-specific code is local to its directory under `services/gateway/src/speech/`. A new speech model implements the small interface in `services/gateway/src/speech/contract.ts` and adds one construction entry in `services/gateway/src/server.ts`; health reporting and routing derive from that router. Translation providers follow the equivalent contract/router seam under `services/gateway/src/translation/`.

## Where to implement the next pieces

1. **Provider benchmarks:** measure Sarvam against representative desktop audio, tracking WER, partial latency, final latency, translation quality, and cost.
2. **Production stream lifecycle:** add explicit backpressure telemetry and provider-level health measurements.
3. **Linux capture:** replace the stub backend with a PulseAudio/PipeWire loopback client.

## Design decisions

- **Tauri 2 + Rust:** native audio and OS integration belong beside the UI, while React keeps the overlay easy to iterate on.
- **Provider modules:** Sarvam owns English/Indic speech and Indic text translation. Gemini Live Translate covers international speech; Gemini text MT covers non-Indic pairs from Sarvam transcripts.
- **WebSocket gateway:** streaming audio and partial captions need a long-lived, bidirectional connection. Live state stays per socket; finalized history is stored locally.
- **Drizzle + Turso:** sessions and finalized caption segments live in a local SQLite file (Rust-rewritten engine) without forcing persistence into the live audio path.
- **Explicit platform backends:** capture code is isolated behind a trait so macOS, Windows, and a future Linux backend can evolve independently. Shared PCM conversion lives in `audio/convert.rs` so mix formats can be tested without OS APIs.

## Current limitations

- Native system-audio capture is implemented on macOS and Windows. Linux still uses the stub backend.
- Windows capture is shared-mode WASAPI loopback of the default render endpoint; exclusive-mode and per-app capture are out of scope.
- Sarvam Realtime STT is wired for English and Indic-language routes.
- Gemini Live Translate covers Gemini's international language matrix for non-Indic spoken sources; it has no cross-provider failover yet.
- Progressive translated captions use Sarvam's text-translation API for English/Indic pairs and Gemini text MT for other pairs; unsupported pairs return a translation error and never display source text as translated text.
- The gateway stores finalized caption segments locally; partial revisions and audio are never stored. Settings → History lists those sessions, searches them, exports Text/SRT/JSON, and can delete them.
- Authentication, rate limiting, billing, and production secrets management are intentionally out of scope for this skeleton.
