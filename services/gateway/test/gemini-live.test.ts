import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderStreamEvent } from "../src/speech/contract.js";
import { GeminiLiveTranslateSession } from "../src/speech/gemini/live.js";
import { FakeGeminiServer, waitForGemini } from "./fake-gemini.js";

test("configures Live Translate, sends 100 ms PCM frames, and correlates transcripts", async () => {
  const server = new FakeGeminiServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new GeminiLiveTranslateSession(
    "test-gemini-key",
    {
      sessionId: "gemini-live-1",
      source: "es",
      target: "en",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    { endpoint, setupTimeoutMs: 250, endTimeoutMs: 250, settleMs: 10 },
  );

  try {
    const opening = session.open();
    const connection = await server.waitForConnection();
    const requestUrl = new URL(connection.request.url ?? "", endpoint);
    assert.equal(requestUrl.searchParams.get("key"), "test-gemini-key");

    const setup = await server.waitForMessage(isSetupMessage);
    assert.deepEqual(setup, {
      setup: {
        model: "models/gemini-3.5-live-translate-preview",
        generationConfig: {
          responseModalities: ["AUDIO"],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          translationConfig: {
            targetLanguageCode: "en",
            echoTargetLanguage: true,
          },
        },
      },
    });
    server.send({ setupComplete: {} });
    await opening;

    session.pushAudio(Buffer.alloc(6_400, 7), 100);
    await waitForGemini(() => {
      const audio = connection.messages.filter(isAudioMessage);
      return audio.length === 2 ? audio : undefined;
    });
    const audioMessages = connection.messages.filter(isAudioMessage);
    assert.deepEqual(audioMessages.map((message) => (
      Buffer.from(message.realtimeInput.audio.data, "base64").byteLength
    )), [3_200, 3_200]);
    assert.ok(audioMessages.every((message) => (
      message.realtimeInput.audio.mimeType === "audio/pcm;rate=16000"
    )));

    session.pushAudio(Buffer.alloc(1_600, 8), 300);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(connection.messages.filter(isAudioMessage).length, 2);
    session.pushAudio(Buffer.alloc(1_600, 9), 350);
    const bufferedAudio = await waitForGemini(() => {
      const audio = connection.messages.filter(isAudioMessage);
      return audio.length === 3 ? audio[2] : undefined;
    });
    assert.equal(
      Buffer.from(bufferedAudio.realtimeInput.audio.data, "base64").byteLength,
      3_200,
    );
    session.pushAudio(Buffer.alloc(800, 10), 400);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(connection.messages.filter(isAudioMessage).length, 3);

    // Google documents no ordering guarantee between these streams.
    server.send({
      serverContent: {
        outputTranscription: { text: "It is an incredible", languageCode: "en" },
      },
    });
    server.send({
      serverContent: {
        inputTranscription: { text: "Es una oportunidad increíble", languageCode: "es" },
      },
    });
    server.send({
      serverContent: {
        outputTranscription: { text: "opportunity", languageCode: "en" },
      },
    });

    await waitForGemini(() => events.find((event) => (
      event.type === "translation"
      && event.text === "It is an incredible opportunity"
      && !event.isFinal
    )));

    const flushing = session.flush();
    await server.waitForMessage(isAudioStreamEnd);
    const finalAudio = connection.messages.filter(isAudioMessage).at(-1);
    assert.ok(finalAudio);
    assert.equal(
      Buffer.from(finalAudio.realtimeInput.audio.data, "base64").byteLength,
      3_200,
    );
    server.send({ serverContent: { turnComplete: true } });
    await flushing;

    assert.ok(events.some((event) => (
      event.type === "transcript"
      && event.text === "Es una oportunidad increíble"
      && event.languageCode === "es"
    )));
    assert.ok(events.some((event) => (
      event.type === "translation"
      && event.text === "It is an incredible opportunity"
      && event.languageCode === "en"
      && event.isFinal
    )));
    assert.ok(events.some((event) => event.type === "speech_start"));
    assert.ok(events.some((event) => event.type === "speech_end"));
  } finally {
    await session.close();
    await server.close();
  }
});

test("rejects a Live Translate connection that never opens", async () => {
  const server = new FakeGeminiServer(true);
  const endpoint = await server.endpoint();
  const session = new GeminiLiveTranslateSession(
    "test-gemini-key",
    {
      sessionId: "gemini-rejected",
      source: "fr",
      target: "en",
      sampleRate: 16_000,
      channels: 1,
      onEvent: () => undefined,
    },
    { endpoint, setupTimeoutMs: 100 },
  );

  try {
    await assert.rejects(session.open(), /rejected|closed before setup/i);
  } finally {
    await session.close();
    await server.close();
  }
});

test("rejects setup immediately when Gemini reports a configuration error", async () => {
  const server = new FakeGeminiServer();
  const endpoint = await server.endpoint();
  const session = new GeminiLiveTranslateSession(
    "test-gemini-key",
    {
      sessionId: "gemini-invalid-config",
      source: "de",
      target: "en",
      sampleRate: 16_000,
      channels: 1,
      onEvent: () => undefined,
    },
    { endpoint, setupTimeoutMs: 1_000 },
  );

  try {
    const opening = session.open();
    await server.waitForMessage(isSetupMessage);
    server.send({ error: { message: "Invalid translation configuration" } });
    await assert.rejects(opening, /invalid translation configuration/i);
  } finally {
    await session.close();
    await server.close();
  }
});

function isSetupMessage(value: unknown): boolean {
  return isRecord(value) && isRecord(value.setup);
}

function isAudioMessage(value: unknown): value is {
  realtimeInput: { audio: { data: string; mimeType: string } };
} {
  return isRecord(value)
    && isRecord(value.realtimeInput)
    && isRecord(value.realtimeInput.audio)
    && typeof value.realtimeInput.audio.data === "string"
    && typeof value.realtimeInput.audio.mimeType === "string";
}

function isAudioStreamEnd(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.realtimeInput)
    && value.realtimeInput.audioStreamEnd === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
