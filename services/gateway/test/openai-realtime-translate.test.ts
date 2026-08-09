import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderStreamEvent } from "../src/speech/contract.js";
import { parseOpenAITranslateMessage } from "../src/speech/openai/messages.js";
import { OpenAITranslateProvider } from "../src/speech/openai/provider.js";
import { OpenAIRealtimeTranslateSession } from "../src/speech/openai/realtime.js";
import { resamplePcmS16leTo24k } from "../src/speech/openai/resample.js";
import { createProviderRouter } from "../src/speech/registry.js";
import { FakeOpenAITranslateServer } from "./fake-openai.js";

test("parses OpenAI translate transcript and error events", () => {
  assert.deepEqual(
    parseOpenAITranslateMessage(JSON.stringify({
      type: "session.output_transcript.delta",
      delta: "Hello",
    })),
    { type: "session.output_transcript.delta", delta: "Hello" },
  );
  assert.equal(parseOpenAITranslateMessage("{").type, "ignored");
  assert.equal(
    parseOpenAITranslateMessage(JSON.stringify({
      type: "error",
      error: { message: "quota" },
    })).type,
    "error",
  );
});

test("resamples 16 kHz mono PCM up to 24 kHz", () => {
  const input = Buffer.alloc(8);
  input.writeInt16LE(0, 0);
  input.writeInt16LE(1000, 2);
  input.writeInt16LE(2000, 4);
  input.writeInt16LE(3000, 6);
  const output = resamplePcmS16leTo24k(input, 16_000);
  assert.equal(output.byteLength, 12);
  assert.equal(resamplePcmS16leTo24k(input, 24_000).equals(input), true);
});

test("routes international translation pairs to OpenAI and keeps same-language on ElevenLabs", () => {
  const router = createProviderRouter({
    sarvamApiKey: "sarvam",
    elevenLabsApiKey: "eleven",
    openAIApiKey: "openai",
  });

  assert.equal(router.select("es", undefined, 16_000, 1, "en").id, "openai");
  assert.equal(router.select("fr", undefined, 16_000, 1, "de").id, "openai");
  assert.equal(router.select("es", undefined, 16_000, 1, "es").id, "elevenlabs");
  assert.equal(router.select("kn", undefined, 16_000, 1, "en").id, "sarvam");
  assert.equal(router.select("auto", undefined, 16_000, 1, "en").id, "sarvam");
  assert.deepEqual(router.availability(), {
    openai: true,
    elevenlabs: true,
    sarvam: true,
    mock: true,
  });
});

test("streams translated captions through OpenAI realtime translate", async () => {
  const fake = new FakeOpenAITranslateServer();
  const events: ProviderStreamEvent[] = [];
  try {
    const endpoint = await fake.endpoint();
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-session",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: (event) => events.push(event),
      },
      { endpoint, utteranceGapMs: 40, flushTimeoutMs: 500 },
    );
    await session.open();
    await fake.waitForConnections(1);

    const auth = fake.connections[0]?.request.headers.authorization;
    assert.equal(auth, "Bearer test-key");

    const update = await fake.waitForMessage(0, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.update"
    ));
    assert.deepEqual(update, {
      type: "session.update",
      session: {
        audio: {
          input: { transcription: { model: "gpt-realtime-whisper" } },
          output: { language: "en" },
        },
      },
    });

    const pcm = Buffer.alloc(320);
    session.pushAudio(pcm, 100);
    const append = await fake.waitForMessage(0, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.input_audio_buffer.append"
    ));
    assert.equal((append as { type: string }).type, "session.input_audio_buffer.append");
    assert.equal(typeof (append as { audio?: string }).audio, "string");

    fake.send(0, { type: "session.input_transcript.delta", delta: "Hola" });
    fake.send(0, { type: "session.output_transcript.delta", delta: "Hello" });

    await waitFor(() => events.some((event) => (
      event.type === "transcript"
      && event.translatedText === "Hello"
      && event.text === "Hola"
      && !event.isFinal
    )));

    await waitFor(() => events.some((event) => (
      event.type === "transcript"
      && event.isFinal
      && event.translatedText === "Hello"
    )));

    await session.close();
  } finally {
    await fake.close();
  }
});

test("OpenAI provider rejects unsupported end-to-end routes", async () => {
  const provider = new OpenAITranslateProvider("key");
  await assert.rejects(
    provider.openSession({
      sessionId: "x",
      source: "kn",
      target: "en",
      sampleRate: 16_000,
      channels: 1,
      onEvent: () => undefined,
    }),
    /does not support kn → en/,
  );
});

async function waitFor(probe: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for OpenAI test condition");
}
