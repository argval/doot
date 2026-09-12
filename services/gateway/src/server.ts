import Fastify from "fastify";
import websocket from "@fastify/websocket";
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_TARGET_LANGUAGES,
  isSupportedLanguage,
  isProviderId,
} from "@doot/protocol";
import { config } from "./config.js";
import {
  registerRealtimeGateway,
  type RealtimeGatewayOptions,
} from "./gateway.js";
import { registerHistoryRoutes } from "./history.js";
import { GeminiProvider } from "./speech/gemini/provider.js";
import { GeminiTranscribeProvider } from "./speech/gemini/transcribe.js";
import { MockProvider } from "./speech/mock/provider.js";
import { ProviderRouter } from "./speech/router.js";
import { SarvamProvider } from "./speech/sarvam/provider.js";
import { SpeechmaticsProvider } from "./speech/speechmatics/provider.js";
import { OpenAITranscribeProvider } from "./speech/openai/provider.js";
import { GeminiTextTranslator } from "./translation/gemini/provider.js";
import { TranslationRouter } from "./translation/router.js";
import { SarvamTextTranslator } from "./translation/sarvam/provider.js";
import { protectGateway } from "./security.js";

export function createProviderRouter(
  credentials: { sarvamApiKey?: string; geminiApiKey?: string; speechmaticsApiKey?: string; openaiApiKey?: string } = {},
): ProviderRouter {
  return new ProviderRouter([
    new SarvamProvider(credentials.sarvamApiKey),
    new GeminiTranscribeProvider(credentials.geminiApiKey),
    new GeminiProvider(credentials.geminiApiKey),
    new SpeechmaticsProvider(credentials.speechmaticsApiKey),
    new OpenAITranscribeProvider(credentials.openaiApiKey),
    new MockProvider(),
  ]);
}

export function createTranslationRouter(
  credentials: { sarvamApiKey?: string; geminiApiKey?: string; speechmaticsApiKey?: string; openaiApiKey?: string } = {},
): TranslationRouter {
  return new TranslationRouter([
    new SarvamTextTranslator(credentials.sarvamApiKey),
    new GeminiTextTranslator(credentials.geminiApiKey),
  ]);
}

export async function buildServer(
  router: ProviderRouter = createProviderRouter({
    sarvamApiKey: config.sarvamApiKey,
    geminiApiKey: config.geminiApiKey,
    speechmaticsApiKey: config.speechmaticsApiKey,
    openaiApiKey: config.openaiApiKey,
  }),
  translation: TranslationRouter = createTranslationRouter({
    sarvamApiKey: config.sarvamApiKey,
    geminiApiKey: config.geminiApiKey,
    speechmaticsApiKey: config.speechmaticsApiKey,
    openaiApiKey: config.openaiApiKey,
  }),
  gatewayOptions: RealtimeGatewayOptions = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024, requestTimeout: 10_000 });
  await app.register(websocket, { options: { maxPayload: 512 * 1024 } });
  // The WebSocket plugin must mark upgrade requests before authentication can
  // reject them, so its onResponse hook closes denied upgrade sockets.
  protectGateway(app, gatewayOptions.authToken);

  app.get("/health", async () => {
    // Coverage comes from working complete routes, never independent unions or mock.
    const pairs = SUPPORTED_LANGUAGES.flatMap((sourceLanguage) => (
      SUPPORTED_LANGUAGES.flatMap((targetLanguage) => {
        try {
          router.resolveRoute({ sourceLanguage, targetLanguage, sampleRate: 16_000, channels: 1 }, translation);
          return [{ sourceLanguage, targetLanguage }];
        } catch {
          return [];
        }
      })
    ));
    return {
      status: "ok",
      service: "doot-gateway",
      providers: router.availability(),
      translation: translation.availability(),
      languages: {
        sources: SUPPORTED_LANGUAGES.filter((language) => pairs.some((pair) => pair.sourceLanguage === language)),
        targets: SUPPORTED_TARGET_LANGUAGES.filter((language) => pairs.some((pair) => pair.targetLanguage === language)),
      },
    };
  });
  app.get("/v1/route", async (request, reply) => {
    const { source, target, provider } = request.query as Record<string, unknown>;
    if (!isSupportedLanguage(source) || !isSupportedLanguage(target)
      || (target === "auto" && source !== "auto")
      || (provider !== undefined && !isProviderId(provider))) {
      return reply.code(400).send({ message: "Choose valid source and target languages. Translate To cannot be Auto." });
    }
    try {
      return router.resolveRoute({
        sourceLanguage: source, targetLanguage: target,
        ...(provider === undefined ? {} : { provider }),
        sampleRate: 16_000, channels: 1,
      }, translation).route;
    } catch (error) {
      return reply.code(422).send({ message: error instanceof Error ? error.message : "Caption route unavailable" });
    }
  });
  registerHistoryRoutes(app, gatewayOptions.db);
  registerRealtimeGateway(app, router, translation, gatewayOptions);
  return app;
}
