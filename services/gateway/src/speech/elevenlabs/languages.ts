import type {
  AudioSampleRate,
  SupportedLanguage,
} from "@doot/protocol";

export const ELEVENLABS_SUPPORTED_LANGUAGES = [
  "auto",
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
] as const satisfies readonly SupportedLanguage[];

type ElevenLabsSupportedLanguage =
  (typeof ELEVENLABS_SUPPORTED_LANGUAGES)[number];

export function isElevenLabsSupportedLanguage(
  value: SupportedLanguage,
): value is ElevenLabsSupportedLanguage {
  return ELEVENLABS_SUPPORTED_LANGUAGES.some((language) => language === value);
}

export const ELEVENLABS_REALTIME_STT_WS =
  "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
export const ELEVENLABS_REALTIME_MODEL = "scribe_v2_realtime";

export function toElevenLabsLanguageCode(
  language: SupportedLanguage,
): string | undefined {
  if (!isElevenLabsSupportedLanguage(language)) {
    throw new Error(`ElevenLabs is not enabled for language: ${language}`);
  }
  return language === "auto" ? undefined : language;
}

export function toElevenLabsAudioFormat(
  sampleRate: AudioSampleRate,
): `pcm_${AudioSampleRate}` {
  return `pcm_${sampleRate}`;
}
