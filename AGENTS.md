## Learned User Preferences

- Prefer Claude/Raycast-style floating captions UI: small, minimal, translucent overlay with no white window chrome or decorative title bars.
- Captions window must stay always-on-top when other apps are focused; it should not disappear behind the frontmost window.
- Language controls should be a small disappearing overlay on/above the captions window, not a full-width top bar that wastes space.
- Captions window should be draggable and resizable; resizing the window must not scale caption text size.
- Prefer a single idle/hover opacity model with a smooth fade (more transparent when idle, more opaque on hover); avoid multi-level or flickering transparency.
- When asked for approach or design, discuss first and do not start implementing until explicitly told to.
- Prefer Sarvam speech models for captioning/translation, especially for Indian languages and code-switched speech (e.g. Hinglish, Kannada–English).
- Prefer TypeScript 7 configured consistently across the monorepo.
- When committing agent work, include `AGENTS.md` updates in the same commit (do not leave them unstaged as unrelated).
- Prefer translated-only captions; do not show source/original transcription under the translation.
- Translated captions should update progressively in realtime (word-by-word feel) while staying sentence-aware—not only after pause or finalization.
- When the captions area fills, keep the latest caption visible (do not clip at the bottom); prefer continuous sentence flow over fragmented short phrases.

## Learned Workspace Facts

- doot is a macOS-first floating live-captions product: system audio → realtime speech/translation → always-on-top overlay.
- Active stack is a monorepo with Tauri 2 + Rust desktop (`apps/desktop`), React + TypeScript + Vite UI, Fastify/TypeScript WebSocket gateway, shared protocol package, and Drizzle/PostgreSQL-oriented persistence.
- System audio capture uses ScreenCaptureKit-style paths and requires macOS Screen Recording permission for testing.
- Sarvam Realtime STT is the primary gateway transport; the legacy streaming client remains an automatic fallback for initial and terminal Realtime failures.
- Speech providers are modular gateway adapters under `services/gateway/src/speech/`; Sarvam owns the Indic lane and ElevenLabs Scribe v2 Realtime owns the initial international lane.
- Speech adapter construction is centralized in `services/gateway/src/speech/registry.ts`; routing and health metadata derive from the registered adapters.
- International launch languages are English, Spanish, French, German, Portuguese, and Italian; translation remains an independent provider seam.
- Unsupported translation pairs emit an unavailable error with blank translated text; source text must never be substituted into translated-only captions.
- Local runs often use bun workspace scripts for the desktop/Tauri app and gateway; `scripts/dev.sh` starts gateway and desktop together.
- Caption pipeline aims for persistent Sarvam streaming with VAD-driven utterance boundaries and code-switch-tolerant Indic translation (including Kannada).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
