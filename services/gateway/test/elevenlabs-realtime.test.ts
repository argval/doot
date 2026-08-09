import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderStreamEvent } from "../src/speech/contract.js";
import {
  ElevenLabsRealtimeSession,
} from "../src/speech/elevenlabs/realtime.js";
import {
  FakeElevenLabsServer,
  waitForElevenLabsCondition,
} from "./fake-elevenlabs.js";

test("uses the Scribe v2 Realtime protocol and normalizes transcript events", async () => {
  const server = new FakeElevenLabsServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new ElevenLabsRealtimeSession(
    "test-elevenlabs-key",
    {
      sessionId: "elevenlabs-1",
      source: "es",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    { endpoint, connectTimeoutMs: 500, flushTimeoutMs: 500 },
  );

  try {
    const opening = session.open();
    await server.waitForConnections(1);
    const request = server.connections[0]?.request;
    assert.ok(request);
    const url = new URL(request.url ?? "", endpoint);
    assert.equal(url.searchParams.get("model_id"), "scribe_v2_realtime");
    assert.equal(url.searchParams.get("audio_format"), "pcm_16000");
    assert.equal(url.searchParams.get("language_code"), "es");
    assert.equal(url.searchParams.get("commit_strategy"), "vad");
    assert.equal(request.headers["xi-api-key"], "test-elevenlabs-key");

    server.send(0, {
      message_type: "session_started",
      session_id: "scribe-session",
    });
    await opening;

    session.pushAudio(Buffer.alloc(3_200, 7), 100);
    const audioMessage = await server.waitForMessage(0, isAudioChunk);
    assert.deepEqual(audioMessage, {
      message_type: "input_audio_chunk",
      audio_base_64: Buffer.alloc(3_200, 7).toString("base64"),
    });

    server.send(0, { message_type: "partial_transcript", text: "hola mun" });
    server.send(0, { message_type: "final_transcript", text: "hola mundo" });
    await waitForElevenLabsCondition(() => events.some((event) => (
      event.type === "transcript" && event.text === "hola mundo"
    )));
    const flushing = session.flush();
    await server.waitForMessage(0, isCommitMessage);
    server.send(0, {
      message_type: "committed_transcript",
      text: "hola mundo",
      language_code: "es",
    });
    await flushing;

    assert.ok(events.some((event) => event.type === "speech_start"));
    assert.ok(events.some((event) => (
      event.type === "transcript"
      && event.text === "hola mun"
      && event.isFinal === false
    )));
    assert.ok(events.some((event) => (
      event.type === "transcript"
      && event.text === "hola mundo"
      && event.languageCode === "es"
      && event.isFinal === true
    )));
    assert.ok(events.some((event) => event.type === "speech_end"));
  } finally {
    await session.close();
    await server.close();
  }
});

test("omits a language hint for automatic detection", async () => {
  const server = new FakeElevenLabsServer();
  const endpoint = await server.endpoint();
  const session = new ElevenLabsRealtimeSession(
    "test-key",
    {
      sessionId: "elevenlabs-auto",
      source: "auto",
      sampleRate: 24_000,
      channels: 1,
      onEvent: () => undefined,
    },
    { endpoint, connectTimeoutMs: 500 },
  );

  try {
    const opening = session.open();
    await server.waitForConnections(1);
    const request = server.connections[0]?.request;
    assert.ok(request);
    const url = new URL(request.url ?? "", endpoint);
    assert.equal(url.searchParams.get("audio_format"), "pcm_24000");
    assert.equal(url.searchParams.get("language_code"), null);
    server.send(0, { message_type: "session_started" });
    await opening;
  } finally {
    await session.close();
    await server.close();
  }
});

test("commits audio on stop even before the first transcript arrives", async () => {
  const server = new FakeElevenLabsServer();
  const endpoint = await server.endpoint();
  const session = new ElevenLabsRealtimeSession(
    "test-key",
    {
      sessionId: "elevenlabs-quick-stop",
      source: "fr",
      sampleRate: 16_000,
      channels: 1,
      onEvent: () => undefined,
    },
    { endpoint, connectTimeoutMs: 500, flushTimeoutMs: 500 },
  );

  try {
    const opening = session.open();
    await server.waitForConnections(1);
    server.send(0, { message_type: "session_started" });
    await opening;
    session.pushAudio(Buffer.alloc(3_200, 9), 100);
    await server.waitForMessage(0, isAudioChunk);

    const flushing = session.flush();
    await server.waitForMessage(0, isCommitMessage);
    server.send(0, { message_type: "committed_transcript", text: "bonjour" });
    await flushing;
  } finally {
    await session.close();
    await server.close();
  }
});

test("reconnects and replays uncommitted audio after a transient disconnect", async () => {
  const server = new FakeElevenLabsServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new ElevenLabsRealtimeSession(
    "test-key",
    {
      sessionId: "elevenlabs-reconnect",
      source: "de",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    {
      endpoint,
      connectTimeoutMs: 500,
      reconnectBaseDelayMs: 10,
      maxReconnectDelayMs: 20,
    },
  );

  try {
    const opening = session.open();
    await server.waitForConnections(1);
    server.send(0, { message_type: "session_started" });
    await opening;
    session.pushAudio(Buffer.alloc(3_200, 11), 100);
    await server.waitForMessage(0, isAudioChunk);

    server.terminate(0);
    await waitForElevenLabsCondition(() => events.some((event) => (
      event.type === "state" && event.state === "reconnecting"
    )));
    session.pushAudio(Buffer.alloc(3_200, 22), 200);
    await server.waitForConnections(2);
    server.send(1, { message_type: "session_started" });
    const replayed = await server.waitForMessage(1, (message) => (
      readAudioByte(message) === 11
    ));
    const queued = await server.waitForMessage(1, (message) => (
      readAudioByte(message) === 22
    ));
    assert.equal(readAudioByte(replayed), 11);
    assert.equal(readAudioByte(queued), 22);
  } finally {
    await session.close();
    await server.close();
  }
});

test("reports a terminal error when the reconnect budget is exhausted", async () => {
  const server = new FakeElevenLabsServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new ElevenLabsRealtimeSession(
    "test-key",
    {
      sessionId: "elevenlabs-reconnect-limit",
      source: "it",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    { endpoint, connectTimeoutMs: 500, maxReconnectAttempts: 0 },
  );

  try {
    const opening = session.open();
    await server.waitForConnections(1);
    server.send(0, { message_type: "session_started" });
    await opening;
    server.terminate(0);

    await waitForElevenLabsCondition(() => events.some((event) => (
      event.type === "error"
      && event.retryable === false
      && event.message.includes("reconnect limit reached")
    )));
    assert.equal(server.connections.length, 1);
  } finally {
    await session.close();
    await server.close();
  }
});

test("bounds queued audio while a disconnected stream waits to reconnect", async () => {
  const server = new FakeElevenLabsServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new ElevenLabsRealtimeSession(
    "test-key",
    {
      sessionId: "elevenlabs-buffer-bound",
      source: "pt",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    {
      endpoint,
      connectTimeoutMs: 500,
      reconnectBaseDelayMs: 1_000,
      maxReconnectDelayMs: 1_000,
    },
  );

  try {
    const opening = session.open();
    await server.waitForConnections(1);
    server.send(0, { message_type: "session_started" });
    await opening;
    server.terminate(0);
    await waitForElevenLabsCondition(() => events.some((event) => (
      event.type === "state" && event.state === "reconnecting"
    )));

    for (let index = 0; index < 80; index += 1) {
      session.pushAudio(Buffer.alloc(3_200, index), index * 100);
    }
    assert.ok(events.some((event) => (
      event.type === "warning" && event.message.includes("oldest audio was dropped")
    )));
  } finally {
    await session.close();
    await server.close();
  }
});

function isAudioChunk(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "message_type" in value
    && value.message_type === "input_audio_chunk"
    && "audio_base_64" in value
    && value.audio_base_64 !== "";
}

function isCommitMessage(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "message_type" in value
    && value.message_type === "input_audio_chunk"
    && "commit" in value
    && value.commit === true;
}

function readAudioByte(value: unknown): number | undefined {
  if (
    typeof value !== "object"
    || value === null
    || !("audio_base_64" in value)
    || typeof value.audio_base_64 !== "string"
    || value.audio_base_64.length === 0
  ) return undefined;
  return Buffer.from(value.audio_base_64, "base64")[0];
}
