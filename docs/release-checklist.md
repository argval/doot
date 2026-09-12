# Desktop release checklist

## Packaged app

`bun run --cwd apps/desktop tauri:build` bundles gateway JavaScript, database migrations, Turso's native addon, the current Node executable and its license. Use the official Node 22 distribution on the target OS. Native Doot launches this private service on an ephemeral loopback port; no shell, `.env` or separately installed Node is needed by users. Development builds use the repo's TypeScript entry point instead.

The current Turso addon supports Apple Silicon macOS and Windows x64. Do not advertise an Intel Mac build until a compatible addon is available and tested. Test installers on clean machines, not just development hosts.

The manual **Desktop release candidates** workflow runs checks and uploads artifacts; it does not publish or install anything. macOS signing/notarization is optional and fails if its requested secrets are absent. Windows artifacts are explicitly unsigned. Choose a Windows signing service/identity before wiring its Tauri `signCommand`; do not mistake updater signatures for OS code signing. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) and [Windows signing](https://v2.tauri.app/distribute/sign/windows/).

Automatic updates remain disabled. Enabling them requires a publisher-controlled HTTPS feed, an update signing key and pinned public key, a release/version policy, and signed replacement artifacts. Test a bad signature, interrupted download, failed install and rollback before enabling an install button. See [Tauri updater configuration](https://v2.tauri.app/plugin/updater/). Never place private signing keys in the repo or application.

## Data and credentials

- Native history lives in the `app.doot.desktop` OS app-data directory (`~/Library/Application Support/app.doot.desktop` on macOS; `%APPDATA%\app.doot.desktop` on Windows). A native process lock prevents two app instances from recovering each other's sessions.
- Standalone development retains `packages/db/data/doot.db`, or `DOOT_DB_PATH`. Existing development history is untouched and is not silently moved into the installed app. Use the standalone gateway and browser History to inspect/export it. Do not run two standalone gateways against one database or point one at a running desktop database.
- Keys go through OS credential storage. Gateway bootstrap secrets use private stdin, not command-line arguments. An ephemeral token protects HTTP/WS; unrelated browser origins are rejected. Readiness only checks configuration, not provider billing or key validity.
- Saving can be disabled for new sessions. Retention changes and deletion run atomically, and never delete an active session. Raw audio is not stored; local transcripts are not additionally encrypted by Doot.

## Manual native acceptance (not replaced by mock tests)

- Fresh install: Setup opens, missing keys/permissions have clear actions; deleting/changing a key while capture is active is refused.
- Explicit three-second audio check detects playback, handles denied permission and leaves capture stopped. Verify no provider requests and no stored audio.
- Start/stop repeatedly; stop during startup/reconnect/final translation; quit while capturing. Capture must stop, finalization must resolve or show an error, and no gateway process should remain.
- Sleep/wake, remove/change the playback device, revoke permission, disconnect/reconnect the network and terminate the gateway. Verify no stuck “Listening,” unbounded buffering or duplicate turn IDs. Unexpectedly ended history must say Interrupted.
- Exercise history save failures (e.g. a temporary read-only test database), retention and recovery using throwaway data. Warnings must survive caption revisions.
- Bright/busy video: translated-only text remains readable; idle controls fade; keyboard focus reveals them. Check minimum window size, resizing, reduced motion/transparency, screen-reader announcements, RTL/CJK/Indic text.
- Click-through: Cmd/Ctrl+Shift+O and tray Unlock work; keyboard positioning and Reset recover an off-screen overlay.
- Run the reference corpus and desktop timing checks in [accuracy.md](accuracy.md). Require bilingual meaning review alongside timing/segmentation scores.

Windows runtime QA, real audio/provider benchmarks, platform signing and update delivery require the corresponding machine, recordings, credentials and publisher configuration. Automated success is not a substitute for those checks.
