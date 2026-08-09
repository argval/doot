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

No API key is needed to inspect the UI or exercise the mock caption path. For live Indian-language captions, set `SARVAM_API_KEY` in the repo-root `.env` (see `.env.example`). Set `ELEVENLABS_API_KEY` to enable Scribe v2 Realtime for same-language international captions. Set `OPENAI_API_KEY` to enable `gpt-realtime-translate` for cross-language international captions (for example Spanish → English). Optionally set `OPENAI_SAFETY_IDENTIFIER` to a pre-hashed, stable user identifier; otherwise the gateway hashes each caption session ID before sending it to OpenAI. The gateway loads these keys on startup and selects a compatible provider automatically.

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

On macOS, start and stop capture from the overlay, the tray menu, or with `Cmd+Shift+D`. The first capture prompts for **Screen & System Audio Recording** permission. With `SARVAM_API_KEY` set, explicit Indian-language routes use Sarvam Realtime with automatic legacy-streaming failover, plus Sarvam text translation. With `OPENAI_API_KEY` set, Auto and explicit cross-language international pairs among English, Spanish, French, German, Portuguese, and Italian use OpenAI `gpt-realtime-translate` end-to-end (audio in → translated captions out); without OpenAI, Auto → English falls back to Sarvam. Same-language international captions use ElevenLabs Scribe v2 Realtime when `ELEVENLABS_API_KEY` is set. Foreign-language → Indic is not enabled yet: it currently reports translation unavailable rather than silently showing the source. Its planned modular route is OpenAI audio → English captions, then Sarvam English → Indic text translation. `TRANSLATION_API_KEY` can hold a separate Sarvam translation key and otherwise falls back to `SARVAM_API_KEY`.

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

The gateway responds with `session_started`, followed by `caption` events. When no `provider` is set, explicit Indic sources route to Sarvam, Auto and explicit cross-language international pairs route to OpenAI realtime translate when configured, and same-language international sources route to ElevenLabs. If OpenAI is not configured, Auto falls back to Sarvam. End-to-end translation providers can emit `translatedText` on transcript events and skip the separate text-translation hop; otherwise normalized transcripts feed the progressive caption stabilizer and Sarvam translation.

Provider-specific code is local to `services/gateway/src/speech/sarvam/`, `services/gateway/src/speech/elevenlabs/`, and `services/gateway/src/speech/openai/`. A new speech model implements the small interface in `services/gateway/src/speech/contract.ts` and adds one construction entry in `services/gateway/src/speech/registry.ts`; health reporting and routing derive from that registry. Text translation providers follow the equivalent contract/router/registry seam under `services/gateway/src/translation/`.

To verify the live OpenAI connection and close protocol without sending audio, run `OPENAI_REALTIME_SMOKE=1 OPENAI_API_KEY=... npm test --workspace @doot/gateway`. The normal test suite keeps that test skipped so local and CI runs do not call the vendor API.

## Where to implement the next pieces

1. **Provider benchmarks:** compare Sarvam, ElevenLabs, and OpenAI realtime translate against representative desktop audio, tracking WER, partial latency, final latency, translation quality, and cost.
2. **Caption persistence:** insert finalized segments through `@doot/db`; keep partial captions in memory only.
3. **Windows capture:** replace the `WasapiBackend` error path with a COM/WASAPI loopback client and endpoint format conversion.
4. **Production stream lifecycle:** add explicit backpressure telemetry and provider-level health measurements.

## Design decisions

- **Tauri 2 + Rust:** native audio and OS integration belong beside the UI, while React keeps the overlay easy to iterate on.
- **Provider modules:** Sarvam owns the Indic speech+translation lane. OpenAI `gpt-realtime-translate` owns cross-language international captions end-to-end. ElevenLabs Scribe v2 Realtime owns same-language international captions. Text translation remains available as an independent seam for STT-only providers.
- **WebSocket gateway:** streaming audio and partial captions need a long-lived, bidirectional connection. The gateway is intentionally stateless beyond each socket for the first version.
- **Drizzle-ready PostgreSQL:** the schema stores sessions and finalized caption segments without forcing persistence into the live audio path.
- **Explicit platform stubs:** platform capture code is isolated behind a trait so macOS, Windows, and a future Linux backend can evolve independently.

## Current limitations

- Native system-audio capture is implemented on macOS only.
- Sarvam Realtime STT is wired for Indian-language routes with legacy-streaming failover; OpenAI `gpt-realtime-translate` covers cross-language international launch pairs; ElevenLabs Scribe v2 Realtime covers same-language international captions.
- Progressive translated captions use Sarvam's text-translation API for English/Indic pairs and OpenAI realtime translate for international pairs among English, Spanish, French, German, Portuguese, and Italian. Foreign-language → Indic requires a future OpenAI-to-Sarvam English-pivot compositor; it is deliberately unsupported today. Unsupported pairs return a translation error and never display source text as translated text.
- OpenAI realtime sessions reconnect with a bounded exponential backoff and replay only the most recent unfinalized audio tail; the next provider delta may revise a partial caption after that replay.
- Finalized captions are not persisted yet.
- Authentication, rate limiting, billing, and production secrets management are intentionally out of scope for this skeleton.
