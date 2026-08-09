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

No API key is needed to inspect the UI or exercise the mock caption path. For live Indian-language captions, set `SARVAM_API_KEY` in the repo-root `.env` (see `.env.example`). Set `ELEVENLABS_API_KEY` to enable Scribe v2 Realtime for English, Spanish, French, German, Portuguese, and Italian. Set `DEEPL_API_KEY` to enable translated captions across those international languages. The gateway loads these keys on startup and selects a compatible provider automatically.

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

On macOS, start and stop capture from the overlay, the tray menu, or with `Cmd+Shift+D`. The first capture prompts for **Screen & System Audio Recording** permission. With `SARVAM_API_KEY` set, Indian-language routes (including Auto → English) use Sarvam Realtime with automatic legacy-streaming failover. With `ELEVENLABS_API_KEY` set, English, Spanish, French, German, Portuguese, and Italian use ElevenLabs Scribe v2 Realtime. Translation is routed independently: Sarvam covers English/Indic pairs (`TRANSLATION_API_KEY` can hold a separate Sarvam translation key and otherwise falls back to `SARVAM_API_KEY`), while DeepL covers international pairs among English, Spanish, French, German, Portuguese, and Italian when `DEEPL_API_KEY` is set.

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

## Protocol

The shared protocol lives in `packages/protocol/src/index.ts`. A client first sends `start_session`, then sends base64-encoded PCM S16LE `audio_chunk` messages, and finally sends `stop_session`.

```json
{
  "type": "start_session",
  "sessionId": "session-id",
  "sourceLanguage": "es",
  "targetLanguage": "en",
  "sampleRate": 16000,
  "channels": 1
}
```

The gateway responds with `session_started`, followed by `caption` events. When no `provider` is set, explicit Indic sources route to Sarvam, initial international sources route to ElevenLabs, and Auto preserves Sarvam’s Indic auto-detection when it is configured. Speech recognition and translation are separate modules: normalized partial/final transcripts feed the existing progressive caption stabilizer, then the translation router produces target-language text.

Provider-specific code is local to `services/gateway/src/speech/sarvam/` and `services/gateway/src/speech/elevenlabs/`. A new speech model implements the small interface in `services/gateway/src/speech/contract.ts` and adds one construction entry in `services/gateway/src/speech/registry.ts`; health reporting and routing derive from that registry. Translation providers follow the equivalent contract/router/registry seam under `services/gateway/src/translation/` (`sarvam/` for Indic, `deepl/` for international).

## Where to implement the next pieces

1. **Provider benchmarks:** compare Sarvam, ElevenLabs, and DeepL against representative desktop audio, tracking WER, partial latency, final latency, translation quality, and cost.
2. **Caption persistence:** insert finalized segments through `@doot/db`; keep partial captions in memory only.
3. **Windows capture:** replace the `WasapiBackend` error path with a COM/WASAPI loopback client and endpoint format conversion.
4. **Production stream lifecycle:** add explicit backpressure telemetry and provider-level health measurements.

## Design decisions

- **Tauri 2 + Rust:** native audio and OS integration belong beside the UI, while React keeps the overlay easy to iterate on.
- **Provider modules:** Sarvam owns the Indic speech lane and ElevenLabs Scribe v2 Realtime owns the initial international speech lane. Translation is independent: Sarvam for English/Indic pairs and DeepL for the international launch languages.
- **WebSocket gateway:** streaming audio and partial captions need a long-lived, bidirectional connection. The gateway is intentionally stateless beyond each socket for the first version.
- **Drizzle-ready PostgreSQL:** the schema stores sessions and finalized caption segments without forcing persistence into the live audio path.
- **Explicit platform stubs:** platform capture code is isolated behind a trait so macOS, Windows, and a future Linux backend can evolve independently.

## Current limitations

- Native system-audio capture is implemented on macOS only.
- Sarvam Realtime STT is wired for Indian-language routes with legacy-streaming failover; ElevenLabs Scribe v2 Realtime is wired for the initial international routes.
- Progressive translated captions use Sarvam for English/Indic pairs and DeepL for international pairs among English, Spanish, French, German, Portuguese, and Italian. Cross-family pairs (for example German → Hindi) remain unavailable and never display source text as translated text.
- Finalized captions are not persisted yet.
- Authentication, rate limiting, billing, and production secrets management are intentionally out of scope for this skeleton.
