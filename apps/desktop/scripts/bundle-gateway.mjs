import { build } from "vite";
import { cp, mkdir, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bundle our JS, retain Turso's platform addon, and ship the same Node used by CI.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const native = resolve(root, "apps/desktop/src-tauri");
const output = resolve(native, "resources/gateway");
const target = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
await build({
  configFile: false, root,
  ssr: { noExternal: true, external: ["@tursodatabase/database", "@tursodatabase/database-common"] },
  build: { target: "node22", ssr: "services/gateway/src/main.ts", outDir: output, emptyOutDir: true, minify: false,
    rollupOptions: { output: { entryFileNames: "main.mjs", banner: 'import { createRequire as dootCreateRequire } from "node:module"; import { fileURLToPath as dootFilePath } from "node:url"; import { dirname as dootDirname } from "node:path"; const require = dootCreateRequire(import.meta.url); const __filename = dootFilePath(import.meta.url); const __dirname = dootDirname(__filename);' } } },
});
for (const name of ["database", "database-common", `database-${process.platform}-${process.arch}${process.platform === "win32" ? "-msvc" : process.platform === "linux" ? "-gnu" : ""}`]) {
  await cp(resolve(root, "node_modules/@tursodatabase", name), resolve(output, "node_modules/@tursodatabase", name), { recursive: true, dereference: true });
}
await cp(resolve(root, "packages/db/drizzle"), resolve(output, "drizzle"), { recursive: true });
await mkdir(resolve(native, "binaries"), { recursive: true });
await cp(process.execPath, resolve(native, `binaries/doot-node-${target}${process.platform === "win32" ? ".exe" : ""}`));
const licenses = [resolve(dirname(process.execPath), "../LICENSE"), resolve(dirname(process.execPath), "LICENSE")];
const license = (await Promise.all(licenses.map(async (path) => await access(path).then(() => path, () => null)))).find(Boolean);
if (!license) throw new Error("Use an official Node distribution containing its LICENSE for packaging.");
await cp(license, resolve(output, "NODE-LICENSE.txt"));
