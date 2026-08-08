## Learned User Preferences

- Prefer Claude/Raycast-style floating captions UI: small, minimal, translucent overlay with no white window chrome or decorative title bars.
- Captions window must stay always-on-top when other apps are focused; it should not disappear behind the frontmost window.
- Language controls should be a small disappearing overlay on/above the captions window, not a full-width top bar that wastes space.
- Captions window should be draggable and resizable; resizing the window must not scale caption text size.
- Prefer a single idle/hover opacity model with a smooth fade (more transparent when idle, more opaque on hover); avoid multi-level or flickering transparency.
- When asked for approach or design, discuss first and do not start implementing until explicitly told to.
- Prefer Sarvam speech models for captioning/translation, especially for Indian languages.
- Prefer TypeScript 7 configured consistently across the monorepo.
- When committing agent work, include `AGENTS.md` updates in the same commit (do not leave them unstaged as unrelated).

## Learned Workspace Facts

- doot is a macOS-first floating live-captions product: system audio → realtime speech/translation → always-on-top overlay.
- Active stack is a monorepo with Tauri 2 + Rust desktop (`apps/desktop`), React + TypeScript + Vite UI, Fastify/TypeScript WebSocket gateway, shared protocol package, and Drizzle/PostgreSQL-oriented persistence.
- System audio capture uses ScreenCaptureKit-style paths and requires macOS Screen Recording permission for testing.
- Sarvam streaming STT is integrated through the gateway; captions need the gateway and desktop app running together.
- Local runs often use bun workspace scripts for the desktop/Tauri app and gateway.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
