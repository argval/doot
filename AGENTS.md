## Learned User Preferences

- Prefer Claude/Raycast-style floating captions UI: small, minimal, translucent overlay with no white window chrome or decorative title bars.
- Captions window must stay always-on-top when other apps are focused; it should not disappear behind the frontmost window.
- Language controls should be a small disappearing overlay on/above the captions window, not a full-width top bar that wastes space.
- Captions window should be draggable and resizable; resizing the window must not scale caption text size.
- Prefer a single idle/hover opacity model with a smooth fade (more transparent when idle, more opaque on hover); avoid multi-level or flickering transparency.
- When asked for approach or design, discuss first and do not start implementing until explicitly told to.
- Prefer Sarvam speech models for captioning/translation, especially for Indian languages and code-switched speech (e.g. Hinglish, Kannada–English).
- For non-Indic/international languages, prefer caption-native STT+MT (Sarvam-like progressive text) over audio→audio interpretation models whose captions are side-channel ASR.
- Prefer TypeScript 7 configured consistently across the monorepo.
- When committing agent work, include `AGENTS.md` updates in the same commit (do not leave them unstaged as unrelated).
- Prefer translated-only captions; do not show source/original transcription under the translation.
- Captions start a new overlay line on each speaker turn, long pause, or section break (VAD-finalized utterance). Short pauses stay on the same line because the gateway coalesces them. Do not concatenate recent turns into one continuous string.
- Settings belong in a separate decorated window, not on the captions overlay.
- Translated captions should update progressively in realtime (word-by-word feel) while staying sentence-aware—not only after pause or finalization; when the captions area fills, keep the latest caption visible and prefer continuous sentence flow over fragmented short phrases.

## Learned Workspace Facts

- doot is a macOS- and Windows-first floating live-captions product: system audio → realtime speech/translation → always-on-top overlay.
- Active stack is a monorepo with Tauri 2 + Rust desktop (`apps/desktop`), React + TypeScript + Vite UI, Fastify/TypeScript WebSocket gateway, shared protocol package, and Drizzle + Turso (embedded SQLite) persistence in `@doot/db`.
- System audio capture uses ScreenCaptureKit on macOS (Screen Recording permission) and WASAPI shared-mode loopback on Windows (default playback device, no microphone permission).
- Capture backends push into a shared PCM converter (`apps/desktop/src-tauri/src/audio/convert.rs`) that emits 16 kHz mono S16LE for the gateway stream.
- Global capture shortcut is `Cmd+Shift+D` on macOS and `Ctrl+Shift+D` on Windows.
- Sarvam Realtime STT is the primary gateway transport; the legacy streaming client remains an automatic fallback for initial and terminal Realtime failures.
- Gemini 3.5 Live Translate (`GEMINI_API_KEY`) covers international spoken sources (Gemini's Live Translate matrix, not a Spanish/French/German-only POC); the overlay has no provider toggle.
- Gemini Live Translate is audio→audio first; captions come from correlated side-channel source/output transcription and bypass the text-translation router (weaker caption UX than Sarvam's STT+MT path).
- English/Indic speech stays on Sarvam. Non-Indic targets from those transcripts use Gemini text MT (`GEMINI_API_KEY`); Indic targets stay on Sarvam Mayura. Auto→English/Indic uses Sarvam; Auto→Spanish/French/etc. uses Gemini Live.
- Speech providers are modular gateway adapters under `services/gateway/src/speech/`; Sarvam owns the English/Indic live-caption and Indic translation lanes.
- Speech adapter construction is centralized in `services/gateway/src/speech/registry.ts`; routing and health metadata derive from the registered adapters.
- Supported live-caption languages are the protocol union of Sarvam Indic + Gemini Live Translate; French/German/Japanese/etc. are valid targets, not just sources.
- Unsupported translation pairs emit an unavailable error with blank translated text; source text must never be substituted into translated-only captions.
- Local runs use npm workspace scripts (`npm run dev` / `scripts/dev.sh` starts gateway and desktop together); package manager is npm, not bun.
- Caption pipeline aims for persistent Sarvam streaming with VAD-driven utterance boundaries and code-switch-tolerant Indic translation (including Kannada).
- Desktop chrome is two windows: the captions overlay stays captions-only, and a decorated Settings window opens from Doot → Settings… (⌘,), the tray, or `open_settings_window`.
- Overlay prefs persist with `tauri-plugin-store` (languages, caption text size, idle opacity, open-at-login, last provider). Overlay position/size persist with `tauri-plugin-window-state`.
- Overlay caption lines map 1:1 to gateway utterances: the last few turns stack as separate lines (previous turns slightly dimmer), instead of joining with spaces.
- Overlay visuals share `apps/desktop/src/tokens.css`. Caption chrome lives in `CaptionPanel` (`apps/desktop/src/overlay/CaptionPanel.tsx`) so Settings can reuse the same panel later.
- The caption panel sets `lang` / `dir` from the **target** language (protocol `od` → HTML `or`). Indic, CJK, and RTL scripts use looser line-height and no negative tracking; Latin keeps tighter display type.
- Overlay shows a hover-only resize grip; caption font size stays a pref and does not scale with the window.
- Browser overlay preview adds `web-preview` on `<html>` so glass shows against a backdrop. Tauri keeps a fully transparent window. Caption/status listeners are skipped in the browser so Tauri `transformCallback` errors do not replace captions.
- Browser-only UI checks: `http://localhost:1420/?preview=captions` (stacked lines), `/?preview=captions-indic` (Kannada metrics), `/?window=settings` (Settings). These query flags are ignored in Tauri.
- Settings Connection is status-only in this phase (gateway reachability, capture backend, last provider). API keys and gateway process still live in `.env` / the terminal.
- Windows Settings copy and overlay shortcut labels should stay OS-neutral (`this computer`, `Ctrl+Shift+D`); do not hardcode Mac-only chrome strings.

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

- Package manager is **npm** (npm workspaces), not bun. A stale `bun.lock` is committed, but CI (`.github/workflows/ci.yml`), the gateway `Dockerfile`, and `scripts/dev.sh` all use npm. Use `npm ci` / `npm run ...`.
- Standard commands are in the root `package.json` and README "Useful checks": `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build` all pass on Linux. Only `@doot/gateway` has tests (Node test runner via `tsx`); only `@doot/desktop` has a lint script (eslint). Desktop PCM conversion tests run with `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`.
- The **Tauri/Rust desktop app is macOS- and Windows-native** (ScreenCaptureKit / WASAPI). Do not try to run `npm run dev`, `npm run dev:tauri`, or `npm run build:tauri` here — they need the native OS layer and real audio capture. CI `native-check` covers macOS on `macos-latest`; `windows-native-check` covers Windows on `windows-latest`.
- What runs on this VM:
  - Gateway: `npm run dev:gateway` → `ws://127.0.0.1:8787` with `GET /health`. Boots with no API keys.
  - Web UI: `npm run dev:web` → Vite on **`http://localhost:1420`**. It binds IPv6 `localhost`, so `http://127.0.0.1:1420` may fail; use `localhost`. In a plain browser the overlay renders but audio capture throws a Tauri `transformCallback` error — expected without the native layer. Overlay glass uses a `web-preview` backdrop. Caption chrome: `/?preview=captions` and `/?preview=captions-indic`. Settings: `/?window=settings`.
- No-key end-to-end testing: the gateway has a built-in `mock` speech provider (always `configured`). Open a realtime session with `provider: "mock"` and equal source/target languages (e.g. `en`→`en`) to get full end-to-end captions without any API keys; the translation router is a passthrough when `source === target`. Live captions need `SARVAM_API_KEY` / `ELEVENLABS_API_KEY` / `TRANSLATION_API_KEY` in the repo-root `.env` (create via `npm run setup`, which copies `.env.example`).
- Turso/SQLite (`npm run db:migrate`) is optional and not wired into the gateway yet (captions are not persisted). The local file defaults to `packages/db/data/doot.db`; override with `DOOT_DB_PATH`. Docker is not required for the database.
