import "dotenv/config";

export const config = {
  host: process.env.GATEWAY_HOST ?? "127.0.0.1",
  port: Number(process.env.GATEWAY_PORT ?? 8787),
  sarvamApiKey: process.env.SARVAM_API_KEY,
  internationalSttApiKey: process.env.INTERNATIONAL_STT_API_KEY,
  translationApiKey: process.env.TRANSLATION_API_KEY,
};
