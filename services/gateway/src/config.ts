import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: path.join(repoRoot, ".env") });

export const config = {
  host: process.env.GATEWAY_HOST ?? "127.0.0.1",
  port: Number(process.env.GATEWAY_PORT ?? 8787),
  sarvamApiKey: process.env.SARVAM_API_KEY,
  translationApiKey: process.env.TRANSLATION_API_KEY,
};
