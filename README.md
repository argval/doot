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
    ├─ gateway connection
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

- Node.js 22 or newer and npm 10 or newer (use Node 22 for release candidates).
- Rust 1.89 or newer and Cargo.
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

No API key is needed to inspect the UI or exercise the mock caption path. Native Doot opens Setup on first use: save your Sarvam and/or Gemini keys in OS credential storage, check permission, then optionally run the local three-second audio check. Standalone gateway development still uses the repo-root `.env`. Sarvam handles English/Indic speech and Indic translation; Gemini handles international speech/translation and text MT after Sarvam for English/Indic→non-Indic.

## Run locally

Start the complete local development environment:

```bash
bun run dev
```

On macOS and Windows this opens native Doot, which manages its private gateway on an authenticated, ephemeral loopback port. No separate gateway terminal is needed. The standalone development gateway uses port 8787 and exposes:

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

The standalone gateway requires `DOOT_GATEWAY_TOKEN` (send it as `Authorization: Bearer …`). For browser-only preview on your computer, `.env.example` explicitly enables unauthenticated loopback development via `DOOT_ALLOW_UNAUTHENTICATED=1`. Never use that mode on a shared host. The native app ignores these settings and generates its own token.

Start and stop capture from the overlay, the tray menu, or the global shortcut (`Cmd+Shift+D` on macOS, `Ctrl+Shift+D` on Windows). On macOS the first capture prompts for **Screen & System Audio Recording** permission. With `SARVAM_API_KEY` set, English and supported Indic-language routes use Sarvam Realtime. Translation is routed independently: Indic pairs use Sarvam; other pairs use Gemini text translation when `GEMINI_API_KEY` is set.

With `GEMINI_API_KEY` set, same-language international captions (Spanish→Spanish, etc.) use `gemini-3.5-transcribe-live`. Translate pairs from international sources (Spanish→English, Auto→Spanish/French/etc.) use `gemini-3.5-live-translate-preview` with native in-session captions. Auto detect uses Sarvam when the target is English or Indic. English→Spanish and similar pairs keep Sarvam speech recognition and Gemini text MT when both keys are configured.

## Caption routing

`services/gateway/src/speech/router.ts` owns the complete route resolver. It selects recognition, validates any required text translator, and pins that translator for the session before opening speech. Provider adapters describe API capabilities; numeric routing priorities are not used.

With both keys configured:

| Selection | Recognition | Translation |
| --- | --- | --- |
| English/Indic transcription | Sarvam | None |
| International transcription | Gemini Transcribe Live | None |
| English/Indic → English/Indic | Sarvam | Sarvam text translation |
| English/Indic → international | Sarvam | Gemini text translation |
| International → another language | Gemini Live Translate | Native to the session |
| Auto transcription | Sarvam | None |
| Auto → English/Indic | Sarvam | Sarvam text translation |
| Auto → international | Gemini Live Translate | Native to the session |

Equal source/target values mean transcription, including `auto → auto`; every other pair means translation and must have a concrete target. This preserves the existing wire format. The resolved route reports its explicit `mode`, speech provider, translation method/provider, description, and Auto detection languages.

Auto is scoped to the selected recognizer: Sarvam detects English and Indic speech, not all international languages. With only Gemini configured, compatible transcription uses Transcribe Live and translation uses Live Translate. With only Sarvam configured, international recognition/targets are unavailable. Missing text translation is rejected before opening speech, rather than after the first utterance. Explicit provider requests still validate capability and credentials. Runtime provider errors do not silently switch engines.

`GET /v1/route?source=en&target=es` reports the configured route without calling a provider. It returns 400 for invalid selections and 422 for unavailable routes. The desktop checks it before starting capture; Settings → Connection shows the selected route. The gateway repeats the same resolution on `start_session` and includes `route` in `session_started`. Configuration checks do not verify key validity or provider uptime.

`/health` language summaries include only languages with a complete configured route. Use `/v1/route` to check a specific pair; independent source/target lists are not a pair matrix. Mock never participates in automatic selection or language coverage: no-key demos/tests must explicitly send `provider: "mock"`.

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

The benchmark runner accepts raw PCM S16LE audio at 16 kHz mono and paces frames against an absolute audio clock. It prints every utterance in speech order, the full finalized transcript/translation, revision counts, errors, and timing distributions. It does not capture the desktop or send audio until you run it with a clip.

```bash
# Prepare a representative clip.
ffmpeg -i spanish-football.wav -ac 1 -ar 16000 -f s16le spanish-football.pcm

# In another terminal, run the configured gateway.
npm run dev:gateway

# Benchmark Gemini Transcribe. Change source/target/provider for each comparison lane.
npm run benchmark:live -- \
  --audio spanish-football.pcm \
  --source es \
  --target es \
  --provider gemini-transcribe \
  --quality-notes "Manual translation assessment"
```

Use equal source/target languages with `--provider gemini-transcribe`. For Spanish→English, French→English, and German→English, use `--provider gemini`. Compare English→Spanish and English→Hindi with `--provider sarvam` against `--provider gemini` as the native Live Translate baseline. Sarvam→Spanish also requires the Gemini key for text translation. The POC does not make external API calls during automated tests.

Locally, invoke the runner directly with `bun run --cwd services/gateway benchmark:live --audio /path/to/clip.pcm --source kn --target en --provider sarvam --reference /path/to/clip.reference.json`. Use short, non-sensitive clips and run the same clip/pair five times before comparing distributions. Keep provider/model, audio, and reference unchanged when comparing a code change.

An optional reference file contains a human-checked source transcript and expected caption-end times relative to the clip start, including the last caption:

```json
{
  "sourceText": "First sentence. Second sentence.",
  "boundariesMs": [1800, 3400]
}
```

References accept up to 5,000 characters. Include short pauses, continuous speech, code-switching, names/numbers, and the scripts you actually use. Review meaning with a speaker of the target language; word/character error rates are transcription checks, not translation-quality scores.

Read the report as follows:

- `firstTranslatedCaptionLatencyMs` and `finalCaptionLatencyMs` are elapsed time from audio streaming start, retained for compatibility. The latter includes the clip duration; it is **not** caption delay.
- `sourceToFirstTranslationMs` reports p50/p95 between the first source caption and first translated caption of each utterance. It measures the text-to-translation portion visible to the client, not total recognition or screen-rendering latency. Native translations can arrive before source text and score zero here.
- `estimatedFinalLagMs` reports p50/p95 of final arrival minus the adapter's audio end timestamp. Adapter timestamps are not word-aligned, so treat this as a diagnostic estimate.
- `referenceScores` includes normalized source word/character error rates and boundary precision/recall/F1 with one-to-one matching within 300ms. Boundary scores also inherit adapter timestamp uncertainty. Missing and extra boundaries are reported separately.
- `turns` preserves source/translated text and arrival times for manual review; `unfinishedTurns` and provider errors prevent a partial result from being mistaken for success. The CLI exits with code 2 for these failures.

Current replay regressions cover multilingual punctuation, English titles/decimals, draft translation during continuing speech, and late Sarvam finals across pauses. Provider VAD remains 500ms for Sarvam and 300ms for Gemini. Sarvam's `balanced` stream mode is retained: its documented `fast` option trades partial accuracy for latency, so compare it on labeled audio before changing the default ([Sarvam realtime documentation](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming)). No live-provider latency reduction or translation-accuracy percentage has been established by the synthetic tests.

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

The gateway responds with `session_started`, followed by `caption` events. Without an explicit provider, Sarvam remains preferred for English/Indic speech, including English→Spanish via Gemini text MT. Gemini Transcribe Live handles same-language international transcription. Gemini Live Translate handles international translate pairs with provider-native captions. Auto uses Sarvam for English/Indic targets and Live Translate otherwise.

Provider-specific code is local to its directory under `services/gateway/src/speech/`. A new speech model implements `services/gateway/src/speech/contract.ts`, is constructed in `server.ts`, and gets an explicit place in the routing policy and matrix tests. Translation providers follow the contract/router seam under `services/gateway/src/translation/`.

## Where to implement the next pieces

1. **Provider benchmarks:** measure Sarvam against representative desktop audio, tracking WER, partial latency, final latency, translation quality, and cost.
2. **Native acceptance:** run the sleep/wake, device, finalization and packaging checks in [the release checklist](docs/release-checklist.md).
3. **Linux capture:** replace the stub backend with a PulseAudio/PipeWire loopback client.

## Design decisions

- **Tauri 2 + Rust:** native audio and OS integration belong beside the UI, while React keeps the overlay easy to iterate on.
- **Provider modules:** Sarvam owns English/Indic speech and Indic text translation. Gemini Transcribe Live covers same-language international transcription. Gemini Live Translate covers international translate pairs. Gemini text MT handles translation after Sarvam STT for English/Indic→non-Indic.
- **WebSocket gateway:** streaming audio and partial captions need a long-lived, bidirectional connection. Live state stays per socket; finalized history is stored locally.
- **Drizzle + Turso:** sessions and finalized caption segments live in a local SQLite file (Rust-rewritten engine) without forcing persistence into the live audio path.
- **Explicit platform backends:** capture code is isolated behind a trait so macOS, Windows, and a future Linux backend can evolve independently. Shared PCM conversion lives in `audio/convert.rs` so mix formats can be tested without OS APIs.

## Current limitations

- Native system-audio capture is implemented on macOS and Windows. Linux still uses the stub backend.
- Windows capture is shared-mode WASAPI loopback of the default render endpoint; exclusive-mode and per-app capture are out of scope.
- Sarvam Realtime STT is wired for English and Indic-language routes.
- Gemini Transcribe Live supports sessions up to 10 minutes and does not provide live word timestamps or speaker diarization. It has no cross-provider failover yet.
- Progressive translated captions use Sarvam's text-translation API for English/Indic pairs and Gemini text MT for other pairs; unsupported pairs return a translation error and never display source text as translated text.
- The gateway stores finalized caption segments locally; partial revisions and audio are never stored. Settings → History supports names, search, paging, Copy transcript and Text/SRT/JSON exports. Unexpectedly closed sessions are marked Interrupted; save failures stay visible. Privacy controls saving for new sessions and retention. Native app data and the existing standalone development database are separate; see [data locations](docs/release-checklist.md#data-and-credentials).
- The glass overlay keeps readable captions during reconnects and errors. Its status distinguishes Starting, Listening, No audio detected after five seconds of silence, Reconnecting, and Stopped. Audio bars reflect PCM activity rather than a simulated animation.
- Translation mode remembers the last pair and the five most recent pairs used for capture. Keyboard focus reveals the hidden controls. Reduced-transparency or increased-contrast preferences make the panel solid; screen readers receive finalized captions rather than every draft revision.
- Settings → Connection shows service/language readiness, permission and timing diagnostics. Setup owns secure keys and the local audio check. Configuration checks do not prove provider credentials are valid. See [repeatable accuracy measurement](docs/accuracy.md) for corpus runs and the limits of desktop latency estimates.
- Browser-only previews are available with `bun run --cwd apps/desktop dev`: `/?preview=captions`, `/?preview=captions-indic`, `/?preview=starting`, `/?preview=listening`, `/?preview=no-audio`, `/?preview=reconnecting`, `/?preview=error`, and `/?window=settings`. These do not capture audio.
- The private gateway authenticates HTTP/WS, rejects foreign origins, limits sockets/sessions and bounds queued audio. It is not a public multi-user service. Hosted billing, Windows code signing and automatic updates still require publisher decisions/configuration; [release candidates](docs/release-checklist.md) are not production releases.
