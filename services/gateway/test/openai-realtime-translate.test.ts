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
  assert.deepEqual(
    parseOpenAITranslateMessage(JSON.stringify({
      type: "error",
      error: { message: "quota", code: "rate_limit_exceeded" },
    })),
    {
      type: "error",
      message: "quota",
      retryable: true,
    },
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
  assert.equal(router.select("auto", undefined, 16_000, 1, "en").id, "openai");
  assert.equal(router.select("auto", undefined, 16_000, 1, "es").id, "openai");
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
      { endpoint, utteranceGapMs: 5_000, flushTimeoutMs: 500 },
    );
    await session.open();
    await fake.waitForConnections(1);

    const auth = fake.connections[0]?.request.headers.authorization;
    assert.equal(auth, "Bearer test-key");
    const safetyIdentifier = fake.connections[0]?.request.headers[
      "openai-safety-identifier"
    ];
    assert.equal(typeof safetyIdentifier, "string");
    if (typeof safetyIdentifier !== "string") {
      throw new Error("Expected an OpenAI safety identifier header");
    }
    assert.match(safetyIdentifier, /^[a-f0-9]{64}$/);

    const update = await fake.waitForMessage(0, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.update"
    ));
    assert.deepEqual(update, {
      type: "session.update",
      session: {
        audio: {
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

    fake.send(0, { type: "session.output_transcript.delta", delta: "Hello" });
    await waitFor(() => events.some((event) => (
      event.type === "transcript"
      && event.translatedText === "Hello"
      && event.text === ""
      && !event.isFinal
    )));

    fake.send(0, { type: "session.input_transcript.delta", delta: "Hola" });

    await waitFor(() => events.some((event) => (
      event.type === "transcript"
      && event.translatedText === "Hello"
      && event.text === "Hola"
      && !event.isFinal
    )));

    await session.flush();

    await waitFor(() => events.some((event) => (
      event.type === "transcript"
      && event.isFinal
      && event.text === "Hola"
      && event.translatedText === "Hello"
    )));

    const close = await fake.waitForMessage(0, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.close"
    ));
    assert.equal((close as { type: string }).type, "session.close");

    await session.close();
  } finally {
    await fake.close();
  }
});

test("keeps a target-only OpenAI final out of the source transcript", async () => {
  const fake = new FakeOpenAITranslateServer();
  const events: ProviderStreamEvent[] = [];
  try {
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-target-only-final",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: (event) => events.push(event),
      },
      { endpoint: await fake.endpoint(), flushTimeoutMs: 500 },
    );
    await session.open();
    await fake.waitForConnections(1);

    fake.send(0, { type: "session.output_transcript.delta", delta: "Hello" });
    await session.flush();

    await waitFor(() => events.some((event) => (
      event.type === "transcript"
      && event.isFinal
      && event.text === ""
      && event.translatedText === "Hello"
    )));
    await session.close();
  } finally {
    await fake.close();
  }
});

test("fails a flush when an audio frame cannot be written", async () => {
  const fake = new FakeOpenAITranslateServer();
  try {
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-send-failure",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: () => undefined,
      },
      { endpoint: await fake.endpoint(), drainTimeoutMs: 500 },
    );
    await session.open();
    await fake.waitForConnections(1);

    const socket = (session as unknown as {
      socket: {
        send(data: string, callback?: (error?: Error) => void): void;
        terminate(): void;
      };
    }).socket;
    const originalSend = socket.send.bind(socket);
    socket.send = (data, callback) => {
      if (data.includes("session.input_audio_buffer.append")) {
        queueMicrotask(() => callback?.(new Error("simulated audio send failure")));
        return;
      }
      originalSend(data, callback);
    };

    session.pushAudio(Buffer.alloc(320), 100);
    await assert.rejects(session.flush(), /simulated audio send failure/);
    await session.close();
  } finally {
    await fake.close();
  }
});

test("warns when the bounded OpenAI audio buffer drops old frames", async () => {
  const fake = new FakeOpenAITranslateServer();
  const events: ProviderStreamEvent[] = [];
  try {
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-buffer-warning",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: (event) => events.push(event),
      },
      { endpoint: await fake.endpoint(), flushTimeoutMs: 500 },
    );
    await session.open();
    await fake.waitForConnections(1);

    const socket = (session as unknown as { socket: object }).socket;
    let backpressured = true;
    Object.defineProperty(socket, "bufferedAmount", {
      configurable: true,
      get: () => backpressured ? 1_000_000 : 0,
    });
    for (let index = 0; index < 45; index += 1) {
      session.pushAudio(Buffer.alloc(3_200), index * 100);
    }
    await waitFor(() => events.some((event) => (
      event.type === "warning"
      && event.message.includes("oldest audio was dropped")
    )));

    backpressured = false;
    await session.close();
  } finally {
    await fake.close();
  }
});

test("reconnects and replays uncommitted OpenAI audio after a disconnect", async () => {
  const fake = new FakeOpenAITranslateServer();
  const events: ProviderStreamEvent[] = [];
  try {
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-reconnect",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: (event) => events.push(event),
      },
      {
        endpoint: await fake.endpoint(),
        reconnectBaseDelayMs: 1,
        maxReconnectDelayMs: 1,
      },
    );
    await session.open();
    await fake.waitForConnections(1);
    session.pushAudio(Buffer.alloc(320), 100);
    await fake.waitForMessage(0, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.input_audio_buffer.append"
    ));

    fake.terminate(0);
    await fake.waitForConnections(2);
    await fake.waitForMessage(1, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.input_audio_buffer.append"
    ));
    await waitFor(() => events.some((event) => (
      event.type === "state" && event.state === "reconnecting"
    )));
    assert.equal(events.some((event) => event.type === "error"), false);

    await session.close();
  } finally {
    await fake.close();
  }
});

test("keeps draining after an unsolicited session.closed and reconnect", async () => {
  const fake = new FakeOpenAITranslateServer();
  try {
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-session-closed-reconnect",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: () => undefined,
      },
      {
        endpoint: await fake.endpoint(),
        reconnectBaseDelayMs: 1,
        maxReconnectDelayMs: 1,
        flushTimeoutMs: 500,
      },
    );
    await session.open();
    await fake.waitForConnections(1);

    fake.send(0, { type: "session.closed" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.terminate(0);
    await fake.waitForConnections(2);

    session.pushAudio(Buffer.alloc(320), 100);
    await session.flush();
    const close = await fake.waitForMessage(1, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.close"
    ));
    assert.equal((close as { type: string }).type, "session.close");
    await session.close();
  } finally {
    await fake.close();
  }
});

test("ends a reconnecting session after its bounded retry budget", async () => {
  const fake = new FakeOpenAITranslateServer();
  const events: ProviderStreamEvent[] = [];
  try {
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-reconnect-budget",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: (event) => events.push(event),
      },
      {
        endpoint: await fake.endpoint(),
        reconnectBaseDelayMs: 1,
        maxReconnectDelayMs: 1,
        maxReconnectAttempts: 1,
      },
    );
    await session.open();
    await fake.waitForConnections(1);
    fake.terminate(0);
    await fake.waitForConnections(2);
    fake.terminate(1);

    await waitFor(() => events.some((event) => (
      event.type === "error" && event.message.includes("reconnect limit reached")
    )));
    const failure = events.find((event) => event.type === "error");
    assert.deepEqual(failure, {
      type: "error",
      message: "OpenAI realtime translate disconnected; reconnect limit reached",
      retryable: false,
    });
    await session.close();
  } finally {
    await fake.close();
  }
});

test("keeps audio queued after an end-to-end final eligible for replay", async () => {
  const fake = new FakeOpenAITranslateServer();
  try {
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-audio-ahead-of-final",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: () => undefined,
      },
      {
        endpoint: await fake.endpoint(),
        reconnectBaseDelayMs: 1,
        maxReconnectDelayMs: 1,
      },
    );
    await session.open();
    await fake.waitForConnections(1);
    session.pushAudio(Buffer.alloc(320, 1), 100);
    session.pushAudio(Buffer.alloc(320, 2), 200);
    await fake.waitForMessage(0, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.input_audio_buffer.append"
    ));
    // The gateway makes this call after a provider final. It must not use the
    // desktop's latest timestamp to discard audio that may be a later phrase.
    session.commitAudioThrough(200);

    fake.terminate(0);
    await fake.waitForConnections(2);
    const replayed = await fake.waitForMessage(1, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.input_audio_buffer.append"
      && typeof (message as { audio?: unknown }).audio === "string"
      && Buffer.from((message as { audio: string }).audio, "base64").includes(2)
    ));
    assert.equal((replayed as { type: string }).type, "session.input_audio_buffer.append");

    await session.close();
  } finally {
    await fake.close();
  }
});

test("closes an OpenAI translation session through session.closed", async () => {
  const fake = new FakeOpenAITranslateServer();
  const events: ProviderStreamEvent[] = [];
  try {
    const session = new OpenAIRealtimeTranslateSession(
      "test-key",
      {
        sessionId: "openai-close",
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: (event) => events.push(event),
      },
      { endpoint: await fake.endpoint(), flushTimeoutMs: 500 },
    );
    await session.open();
    await fake.waitForConnections(1);

    await session.close();

    const close = await fake.waitForMessage(0, (message) => (
      typeof message === "object"
      && message !== null
      && (message as { type?: string }).type === "session.close"
    ));
    assert.equal((close as { type: string }).type, "session.close");
    assert.equal(events.some((event) => (
      event.type === "state" && event.state === "closed"
    )), true);
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
