# Doot

Doot is a cross-platform desktop application for live captions and translation of audio playing on a computer. The project is deliberately split into a native desktop engine, a replaceable provider layer, and a small realtime gateway.

The current repository is a runnable skeleton. The UI, command/event boundaries, WebSocket protocol, provider routing, and database schema are present. OS audio capture and vendor streaming adapters are explicit implementation seams and return clear scaffold errors until their platform permissions and SDK wiring are added.

## Architecture

```text
apps/desktop
  React + TypeScript + Vite
        │ Tauri commands/events
  Rust audio engine
    ├─ capture backend seam (ScreenCaptureKit / WASAPI)
    ├─ provider router
    └─ caption session state
        │ WebSocket (planned streaming path)
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
- Docker Desktop (only needed for PostgreSQL).

On macOS, the eventual ScreenCaptureKit implementation will need Screen Recording permission. On Windows, the WASAPI loopback implementation will use the default render endpoint and does not require microphone permission for system audio.

## Bootstrap

```bash
npm install
npm run setup
docker compose up -d postgres
```

No API key is needed to inspect the UI or run the gateway. Provider adapters intentionally report a configuration/scaffold message until credentials and vendor websocket clients are added.

## Run locally

Start the complete local development environment:

```bash
npm run dev
```

This opens the native Doot desktop app and starts the gateway. The gateway exposes:

- `GET http://127.0.0.1:8787/health`
- `ws://127.0.0.1:8787/v1/realtime`

To work on the browser UI without Tauri:

```bash
npm run dev:web
```

To run the services individually:

```bash
npm run dev:gateway
npm run dev:tauri
```

The `Start Capturing` action exercises the Tauri command boundary. On macOS and Windows the platform backend currently returns a scaffold error; on other platforms the stub backend lets you exercise session state and UI behavior.

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

The gateway responds with `session_started`, followed by `caption` events. The provider stream should be connected at the TODO in `services/gateway/src/gateway.ts`; keep the gateway responsible for orchestration and keep vendor SDK details inside `services/gateway/src/providers.ts`.

## Where to implement the next pieces

1. **macOS capture:** replace the `ScreenCaptureKitBackend` error path with an `SCStream` audio-only output, a permission check, and a bounded PCM ring buffer.
2. **Windows capture:** replace the `WasapiBackend` error path with a COM/WASAPI loopback client and endpoint format conversion.
3. **Rust stream manager:** consume `AudioFrame` values, batch them into protocol-sized chunks, and send them over a gateway WebSocket.
4. **Provider adapters:** implement streaming clients for Sarvam and an international STT/translation provider, including reconnect, backpressure, partial-result stabilization, and final-result timing.
5. **Caption persistence:** insert finalized segments through `@doot/db`; keep partial captions in memory only.
6. **Overlay window:** add a dedicated transparent, always-on-top Tauri window once the caption state is flowing end-to-end.

## Design decisions

- **Tauri 2 + Rust:** native audio and OS integration belong beside the UI, while React keeps the overlay easy to iterate on.
- **Provider abstraction:** Sarvam is selected for supported Indian-language routes; the international provider is the fallback. This avoids coupling the product to one vendor’s language coverage.
- **WebSocket gateway:** streaming audio and partial captions need a long-lived, bidirectional connection. The gateway is intentionally stateless beyond each socket for the first version.
- **Drizzle-ready PostgreSQL:** the schema stores sessions and finalized caption segments without forcing persistence into the live audio path.
- **Explicit platform stubs:** platform capture code is isolated behind a trait so macOS, Windows, and a future Linux backend can evolve independently.

## Current limitations

- Audio capture is not yet connected to a real native device.
- Provider streaming clients are placeholders and do not call external APIs.
- The desktop UI displays the local session boundary; it does not yet stream PCM to the gateway.
- Authentication, rate limiting, billing, and production secrets management are intentionally out of scope for this skeleton.
