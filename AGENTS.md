## Learned User Preferences

- Prefer Claude/Raycast-style floating captions: small, minimal, truly translucent glass with no opaque corner chrome, white window chrome, or decorative title bars; the captions window must stay always-on-top when other apps are focused.
- Language controls should be a small disappearing overlay on/above the captions window (not a full-width top bar); the Languages icon toggles translate (From + To) vs same-language transcription, and a small capture/record control stays on the overlay.
- Captions window should be draggable and resizable; resizing must not scale caption text size. Prefer a single idle/hover opacity model with a smooth fade (more transparent when idle, more opaque on hover).
- When asked for approach or design, discuss first and do not start implementing until explicitly told to.
- Prefer Sarvam speech models for English/Indic captioning and translation, especially code-switched speech (e.g. Hinglish, Kannada–English). For non-Indic/international languages, prefer caption-native STT+MT (Sarvam-like progressive text) over audio→audio interpretation models whose captions are side-channel ASR.
- Prefer TypeScript 7 configured consistently across the monorepo.
- When committing agent work, include `AGENTS.md` updates in the same commit (do not leave them unstaged as unrelated).
- Prefer translated-only captions (no source/original under the translation); update progressively in realtime (word-by-word feel) while staying sentence-aware; when the area fills, keep the latest caption visible and prefer continuous sentence flow over fragmented phrases.
- Transcription (translate off) includes Auto detect; Translate To cannot be Auto. Turning translate on from Auto transcription sets To to English.
- Captions start a new overlay line for each provider-finalized speech interval. Pauses below the provider's VAD threshold stay on the same line; once the provider emits `speech_end`, resumed speech starts a new line even while late transcript/translation work settles. Do not concatenate recent turns or deduplicate distinct `utteranceId`s. Gemini Live (Spanish/international) uses a 300ms silence window and also soft-splits long continuous turns on sentence boundaries (~2.5s+) with a hard max around 5.5s so dense commentary still gets new lines.
- Settings belong in a separate decorated window, not on the captions overlay.

## Learned Workspace Facts

- doot is a macOS- and Windows-first floating live-captions product: system audio → realtime speech/translation → always-on-top overlay.
- Active stack is a monorepo with Tauri 2 + Rust desktop (`apps/desktop`), React + TypeScript + Vite UI, Fastify/TypeScript WebSocket gateway, shared protocol package, and Drizzle + Turso (embedded SQLite) in `@doot/db`. Local runs use bun (`bun run dev`); CI uses npm.
- System audio capture uses ScreenCaptureKit on macOS (Screen Recording permission) and WASAPI shared-mode loopback on Windows; backends push into a shared PCM converter that emits 16 kHz mono S16LE. Global shortcut is `Cmd+Shift+D` (macOS) / `Ctrl+Shift+D` (Windows).
- Speech providers are modular gateway adapters under `services/gateway/src/speech/`; construction is in `server.ts`. Sarvam Realtime STT owns English/Indic live-caption; Sarvam Mayura owns Indic translation.
- Gemini 3.5 Live Translate (`GEMINI_API_KEY`) covers international spoken sources (audio→audio first; captions from side-channel transcription, bypassing text MT). English/Indic→Indic uses Sarvam Mayura; English/Indic→non-Indic uses Gemini text MT. Auto→English/Indic uses Sarvam; Auto→Spanish/French/etc. uses Gemini Live. Unsupported pairs emit an unavailable error with blank translated text—never substitute source into translated-only captions.
- Supported live-caption languages are the protocol union of Sarvam Indic + Gemini Live Translate (French/German/Japanese/etc. are valid targets, not just sources). The overlay has no provider toggle.
- Desktop chrome is two windows: captions-only overlay and a decorated Settings window (Doot → Settings… / tray / `open_settings_window`). Doot, Window, and the tray include Show / Hide Overlay (toggles caption-window visibility; does not stop capture). Overlay prefs use `tauri-plugin-store`; position/size use `tauri-plugin-window-state`.
- Overlay visuals share `apps/desktop/src/tokens.css`; caption chrome lives in `CaptionPanel`. Utterance lines stack 1:1 with gateway turns; hover-only resize grip; capture pulse while live; language selects lock until stop; listening empty state uses audio bars; errors offer Open Settings. New turns fade/slide in; `prefers-reduced-motion` disables pulse/bars/slide.
- Settings Captions embeds `CaptionPanel` as a live preview with Ghost / Balanced / Solid idle-opacity presets. Language From/To live on the overlay, not in Settings. The panel sets `lang` / `dir` from the target language (protocol `od` → HTML `or`); Indic/CJK/RTL use looser metrics than Latin.
- Settings History lists locally persisted finalized sessions from the gateway (`GET /v1/history/sessions`). Search matches caption text and language names; a session opens as a transcript with Text / Subtitles / JSON export and delete. Live in-progress sessions stay off the list until they stop. The overlay stays captions-only.
- Browser overlay preview adds `web-preview` on `<html>`; Tauri stays fully transparent. Caption/status listeners are skipped in the browser. Preview flags (`/?preview=…`, `/?window=settings`) are ignored in Tauri; starting capture in the browser shows a desktop-app error.
- Settings Connection is status-only in this phase (gateway reachability, capture backend, last provider); API keys and gateway process still live in `.env` / the terminal. Windows Settings copy and shortcut labels should stay OS-neutral (`this computer`, `Ctrl+Shift+D`).
- Caption timing is audio-duration-aware: adapters derive speech-start and transcript/end timestamps from PCM interval boundaries. Provider VAD owns utterance boundaries; Gemini Live additionally soft-splits long continuous activities for caption readability. Gateway grace only waits for late events, translation cadence does not define line identity, and only one draft translation runs per turn while the latest source revision is queued.
- Caption pipeline aims for persistent Sarvam streaming with VAD-driven utterance boundaries and code-switch-tolerant Indic translation (including Kannada).
- Gateway startup migrates the local Turso SQLite database; it stores one row per successfully opened session, finalized caption segments only, and the session stop time. Draft captions and raw audio stay in memory. Settings History reads that store over HTTP on the local gateway.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Cursor Cloud specific instructions

Environment: Linux VM with Node 22, npm 10, and Rust 1.83 preinstalled. Docker is NOT preinstalled. The startup update script runs `npm ci`.

- Package manager is **bun** locally. CI (`.github/workflows/ci.yml`) and the gateway `Dockerfile` still use npm. Use `bun run ...` on this machine; cloud/CI use `npm ci` / `npm run ...`.
- Standard commands are in the root `package.json` and README "Useful checks": `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` all pass on Linux. Only `@doot/gateway` has tests (Node test runner via `tsx`); only `@doot/desktop` has a lint script (eslint). Desktop PCM conversion tests run with `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`.
- The **Tauri/Rust desktop app is macOS- and Windows-native** (ScreenCaptureKit / WASAPI). Do not try to run `npm run dev`, `npm run dev:tauri`, or `npm run build:tauri` here — they need the native OS layer and real audio capture. CI `native-check` covers macOS on `macos-latest`; `windows-native-check` covers Windows on `windows-latest`.
- What runs on this VM:
  - Gateway: `npm run dev:gateway` → `ws://127.0.0.1:8787` with `GET /health`. Boots with no API keys.
  - Web UI: `npm run dev:web` → Vite on **`http://localhost:1420`**. It binds IPv6 `localhost`, so `http://127.0.0.1:1420` may fail; use `localhost`. Overlay glass uses a `web-preview` backdrop. Caption chrome: `/?preview=captions`, `/?preview=captions-indic`, `/?preview=listening`, `/?preview=error`. Settings: `/?window=settings` (Captions has a live overlay preview; History talks to the local gateway). Starting capture in the browser shows a desktop-app error; it does not call Tauri.
- No-key end-to-end testing: the gateway has a built-in `mock` speech provider (always `configured`). Open a realtime session with `provider: "mock"` and equal source/target languages (e.g. `en`→`en`) to get full end-to-end captions without any API keys; the translation router is a passthrough when `source === target`. Live captions need `SARVAM_API_KEY` / `GEMINI_API_KEY` in the repo-root `.env` (create via `npm run setup`, which copies `.env.example`).
  - Turso/SQLite is migrated when the gateway starts; `npm run db:migrate` remains available for manual verification. The local file defaults to `packages/db/data/doot.db`; override with `DOOT_DB_PATH`. Docker is not required for the database.
