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

No API key is needed to inspect the UI or exercise the mock caption path. For live Indian-language captions, set `SARVAM_API_KEY` in the repo-root `.env` (see `.env.example`). The gateway loads that file on startup and selects Sarvam automatically for supported routes.

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

On macOS, start and stop capture from the overlay, the tray menu, or with `Cmd+Shift+D`. The first capture prompts for **Screen & System Audio Recording** permission. With `SARVAM_API_KEY` set in the repo-root `.env`, Indian-language routes (including Auto → English) use Sarvam’s Realtime STT API. If Realtime cannot connect or reports a terminal provider failure, the gateway automatically continues with Sarvam’s legacy streaming API; without a key it uses deterministic mock captions.

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

The gateway responds with `session_started`, followed by `caption` events. When no `provider` is set, the gateway picks Sarvam for supported Indian-language pairs if `SARVAM_API_KEY` is present, otherwise mock. The Sarvam provider uses `saaras:v3-realtime` first, retains source-language partials for progressive translation, and has an automatic legacy-streaming failover. Keep gateway orchestration separate from vendor SDK details in `services/gateway/src/providers.ts` and `services/gateway/src/sarvam.ts`.

## Where to implement the next pieces

1. **International STT adapter:** implement the streaming client for non-Indic routes, including reconnect, backpressure, partial-result stabilization, and final-result timing.
2. **Caption persistence:** insert finalized segments through `@doot/db`; keep partial captions in memory only.
3. **Windows capture:** replace the `WasapiBackend` error path with a COM/WASAPI loopback client and endpoint format conversion.
4. **Production stream lifecycle:** add gateway reconnect policy, explicit backpressure telemetry, and final-segment flushing on stop.

## Design decisions

- **Tauri 2 + Rust:** native audio and OS integration belong beside the UI, while React keeps the overlay easy to iterate on.
- **Provider abstraction:** Sarvam is selected for supported Indian-language routes; the international provider is the fallback. This avoids coupling the product to one vendor’s language coverage.
- **WebSocket gateway:** streaming audio and partial captions need a long-lived, bidirectional connection. The gateway is intentionally stateless beyond each socket for the first version.
- **Drizzle-ready PostgreSQL:** the schema stores sessions and finalized caption segments without forcing persistence into the live audio path.
- **Explicit platform stubs:** platform capture code is isolated behind a trait so macOS, Windows, and a future Linux backend can evolve independently.

## Current limitations

- Native system-audio capture is implemented on macOS only.
- Sarvam Realtime STT is wired for Indian-language routes with legacy-streaming failover; the international STT adapter remains a scaffold.
- Progressive translated captions use Sarvam's text-translation API because Realtime partial transcripts are source-language text by design.
- Finalized captions are not persisted yet.
- Authentication, rate limiting, billing, and production secrets management are intentionally out of scope for this skeleton.
