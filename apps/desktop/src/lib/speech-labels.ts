const SPEECH_PROVIDER_LABELS: Record<string, string> = {
  sarvam: "Sarvam recognition",
  "gemini-transcribe": "Gemini Transcribe Live",
  gemini: "Gemini Live Translate",
  speechmatics: "Speechmatics Realtime",
  "openai-transcribe": "OpenAI GPT Live Transcribe",
  mock: "Demo captions",
};

export function speechProviderLabel(id: string | null | undefined): string | null {
  if (!id) {
    return null;
  }
  return SPEECH_PROVIDER_LABELS[id] ?? id;
}
