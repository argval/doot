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
packages/db             Drizzle schema and PostgreSQL client
infra                    Local PostgreSQL compose setup
```

## Prerequisites

- Node.js 20 or newer and npm 10 or newer.
- Rust stable and Cargo.
- Tauri 2 system prerequisites for your operating system. Follow the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- macOS 14 or newer for the current ScreenCaptureKit implementation.
- Docker Desktop (only needed for PostgreSQL).

On macOS, the eventual ScreenCaptureKit implementation will need Screen Recording permission. On Windows, the WASAPI loopback implementation will use the default render endpoint and does not require microphone permission for system audio.

## Bootstrap

```bash
npm install
npm run setup
docker compose up -d postgres
```

No API key is needed to inspect the UI or exercise the mock caption path. For live captions, set `SARVAM_API_KEY` and/or `GEMINI_API_KEY` in the repo-root `.env` (see `.env.example`). Sarvam handles English and Indic routes; the Gemini Live Translate benchmark lane handles Spanish, French, and German sources plus explicitly requested English/Hindi comparisons.

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

On macOS, start and stop capture from the overlay, the tray menu, or with `Cmd+Shift+D`. The first capture prompts for **Screen & System Audio Recording** permission. With `SARVAM_API_KEY` set, English and supported Indic-language routes use Sarvam Realtime with automatic legacy-streaming failover. Translation is routed independently; `TRANSLATION_API_KEY` can hold a separate Sarvam translation key and otherwise falls back to `SARVAM_API_KEY`.

With `GEMINI_API_KEY` set, Spanish, French, and German sources route through `gemini-3.5-live-translate-preview`. Gemini's source and translated transcripts are correlated inside one provider session; translated updates bypass the separate text translator and remain translated-only in the overlay. English→Spanish and English→Hindi use Gemini only when explicitly requested by the benchmark client. Auto detection continues to prefer Sarvam and is intentionally unchanged for this POC.

Windows still returns the explicit WASAPI scaffold error. Other platforms retain the stub backend for session-state development.

## Useful checks

```bash
npm run typecheck
npm run build
npm run test
npm run lint --workspace @doot/desktop
npm run db:generate
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

The gateway responds with `session_started`, followed by `caption` events. Without an explicit provider, Sarvam remains preferred for supported English/Indic pairs, Gemini handles configured Spanish/French/German source routes, and Auto retains Sarvam's automatic detection. Sarvam source transcripts use the independent text-translation router; Gemini emits provider-native translated revisions through the same caption stabilizer.

Provider-specific code is local to its directory under `services/gateway/src/speech/`. A new speech model implements the small interface in `services/gateway/src/speech/contract.ts` and adds one construction entry in `services/gateway/src/speech/registry.ts`; health reporting and routing derive from that registry. Translation providers follow the equivalent contract/router/registry seam under `services/gateway/src/translation/`.

## Where to implement the next pieces

1. **Provider benchmarks:** measure Sarvam against representative desktop audio, tracking WER, partial latency, final latency, translation quality, and cost.
2. **Caption persistence:** insert finalized segments through `@doot/db`; keep partial captions in memory only.
3. **Windows capture:** replace the `WasapiBackend` error path with a COM/WASAPI loopback client and endpoint format conversion.
4. **Production stream lifecycle:** add explicit backpressure telemetry and provider-level health measurements.

## Design decisions

- **Tauri 2 + Rust:** native audio and OS integration belong beside the UI, while React keeps the overlay easy to iterate on.
- **Provider modules:** Sarvam owns the supported speech and independent Indic text-translation lanes. Gemini's benchmark adapter exposes its provider-native translated transcript through the shared speech-event contract.
- **WebSocket gateway:** streaming audio and partial captions need a long-lived, bidirectional connection. The gateway is intentionally stateless beyond each socket for the first version.
- **Drizzle-ready PostgreSQL:** the schema stores sessions and finalized caption segments without forcing persistence into the live audio path.
- **Explicit platform stubs:** platform capture code is isolated behind a trait so macOS, Windows, and a future Linux backend can evolve independently.

## Current limitations

- Native system-audio capture is implemented on macOS only.
- Sarvam Realtime STT is wired for English and Indic-language routes with legacy-streaming failover.
- Gemini Live Translate is a preview benchmark lane limited in-product to Spanish, French, and German sources and Spanish, English, or Hindi targets; it has no cross-provider failover yet.
- Progressive translated captions use Sarvam's text-translation API for supported English/Indic pairs; unsupported pairs return a translation error and never display source text as translated text.
- Finalized captions are not persisted yet.
- Authentication, rate limiting, billing, and production secrets management are intentionally out of scope for this skeleton.
