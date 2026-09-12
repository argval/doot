import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../src-tauri");
const target = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const temporary = await mkdtemp(join(tmpdir(), "doot-bundle-check-"));
const app = process.argv[2] ? resolve(process.argv[2]) : null;
const runtime = app ? resolve(app, "Contents/MacOS/doot-node") : resolve(native, `binaries/doot-node-${target}${process.platform === "win32" ? ".exe" : ""}`);
const gateway = app ? resolve(app, "Contents/Resources/gateway") : resolve(native, "resources/gateway");
const child = spawn(runtime, [resolve(gateway, "main.mjs"), "--managed"], {
  cwd: temporary, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", SARVAM_API_KEY: "", GEMINI_API_KEY: "" }, stdio: ["pipe", "pipe", "pipe"],
});
const timer = setTimeout(() => { child.kill(); throw new Error("Bundled gateway timed out"); }, 15000);
const lines = createInterface({ input: child.stdout });
const exited = once(child, "exit");
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
try {
  const ready = once(lines, "line");
  child.stdin.write(JSON.stringify({ authToken: "test-token-not-a-secret-000000000000", dbPath: join(temporary, "doot.db"), migrationsFolder: resolve(gateway, "drizzle") }) + "\n");
  const [line] = await Promise.race([ready, exited.then(([code]) => { throw new Error(`Bundled gateway exited before readiness (${code})`); })]);
  const { port } = JSON.parse(line);
  const url = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${url}/health`)).status, 401);
  const headers = { Authorization: "Bearer test-token-not-a-secret-000000000000" };
  assert.equal((await fetch(`${url}/health`, { headers })).status, 200);
  assert.deepEqual(await (await fetch(`${url}/v1/history/sessions`, { headers })).json(), { sessions: [] });
  child.stdin.end("stop\n");
  assert.equal((await exited)[0], 0);
  // Parent death during startup must not leave a service behind on an unknown port.
  const orphan = spawn(runtime, [resolve(gateway, "main.mjs"), "--managed"], {
    cwd: temporary, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "", SARVAM_API_KEY: "", GEMINI_API_KEY: "" }, stdio: ["pipe", "ignore", "pipe"],
  });
  orphan.stderr.on("data", (chunk) => process.stderr.write(chunk));
  const orphanExited = once(orphan, "exit", { signal: AbortSignal.timeout(5000) });
  orphan.stdin.end(JSON.stringify({ authToken: "test-token-not-a-secret-000000000000", dbPath: join(temporary, "parent-exit.db"), migrationsFolder: resolve(gateway, "drizzle") }) + "\n");
  try { assert.equal((await orphanExited)[0], 0); } finally { orphan.kill(); }
  console.log("Bundled gateway starts outside the repo, authenticates, migrates history, and stops cleanly.");
} finally { clearTimeout(timer); lines.close(); child.kill(); }
