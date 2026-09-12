import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
try {
  if (!process.argv.includes("--managed")) process.loadEnvFile(path.join(repoRoot, ".env"));
} catch {
  // ponytail: optional local .env
}

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export const config = {
  host: process.env.GATEWAY_HOST ?? "127.0.0.1",
  port: Number(process.env.GATEWAY_PORT ?? 8787),
  sarvamApiKey: env("SARVAM_API_KEY"),
  geminiApiKey: env("GEMINI_API_KEY"),
  speechmaticsApiKey: env("SPEECHMATICS_API_KEY"),
  openaiApiKey: env("OPENAI_API_KEY"),
  authToken: env("DOOT_GATEWAY_TOKEN"),
};
