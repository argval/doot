import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderStreamEvent } from "../src/providers.js";
import { SarvamStreamingSession } from "../src/sarvam-stream.js";
import { FakeSarvamServer } from "./fake-sarvam.js";

test("keeps one codemix/VAD Sarvam connection and forwards continuous PCM", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamStreamingSession(
    "test-key",
    {
      sessionId: "stream-1",
      source: "kn",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    { endpoint, flushTimeoutMs: 200 },
  );

  try {
    await session.open();
    session.pushAudio(Buffer.alloc(3_200, 1), 100);
    session.pushAudio(Buffer.alloc(3_200, 2), 200);
    await server.waitForAudioFrames(0, 2);

    assert.equal(server.connections.length, 1);
    const request = server.connections[0]?.request;
    assert.ok(request);
    const url = new URL(request.url ?? "", endpoint);
    assert.equal(url.searchParams.get("mode"), "codemix");
    assert.equal(url.searchParams.get("language-code"), "kn-IN");
    assert.equal(url.searchParams.get("vad_signals"), "true");
    assert.equal(url.searchParams.get("high_vad_sensitivity"), "false");
    assert.equal(request.headers["api-subscription-key"], "test-key");

    server.send(0, {
      type: "events",
      data: { signal_type: "START_SPEECH" },
    });
    server.send(0, {
      type: "data",
      data: { transcript: "ನಾನು Cursor use ಮಾಡುತ್ತೇನೆ", language_code: "kn-IN" },
    });
    server.send(0, {
      type: "events",
      data: { signal_type: "END_SPEECH" },
    });
    await waitFor(() => events.some((event) => event.type === "speech_end"));

    assert.ok(events.some((event) => event.type === "speech_start"));
    assert.ok(events.some((event) => (
      event.type === "transcript"
      && event.text === "ನಾನು Cursor use ಮಾಡುತ್ತೇನೆ"
      && event.languageCode === "kn-IN"
    )));

    const flush = session.flush();
    await server.waitForFlush(0);
    server.send(0, {
      type: "data",
      data: { transcript: "flushed transcript", language_code: "kn-IN" },
    });
    server.send(0, {
      type: "events",
      data: { signal_type: "END_SPEECH" },
    });
    await flush;
    assert.equal(server.connections.length, 1);
  } finally {
    await session.close();
    await server.close();
  }
});

test("replays a bounded audio tail and queued frames after reconnecting", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamStreamingSession(
    "test-key",
    {
      sessionId: "stream-reconnect",
      source: "hi",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    {
      endpoint,
      reconnectBaseDelayMs: 10,
      maxReconnectDelayMs: 20,
      connectTimeoutMs: 500,
    },
  );

  try {
    await session.open();
    session.pushAudio(Buffer.alloc(3_200, 11), 100);
    await server.waitForAudioFrames(0, 1);
    server.terminate(0);
    await waitFor(() => (
      events.some((event) => (
        event.type === "state" && event.state === "reconnecting"
      ))
    ));

    session.pushAudio(Buffer.alloc(3_200, 22), 200);
    await server.waitForConnections(2);
    const replayed = await server.waitForAudioFrames(1, 2);
    const firstBytes = replayed
      .map(readAudioData)
      .filter((value): value is Buffer => value !== null)
      .map((audio) => audio[0]);

    assert.ok(firstBytes.includes(11), "expected the pre-disconnect tail to replay");
    assert.ok(firstBytes.includes(22), "expected queued reconnect audio to forward");
  } finally {
    await session.close();
    await server.close();
  }
});

test("does not replay audio committed by a finalized utterance", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamStreamingSession(
    "test-key",
    {
      sessionId: "stream-committed",
      source: "kn",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    {
      endpoint,
      reconnectBaseDelayMs: 10,
      maxReconnectDelayMs: 20,
    },
  );

  try {
    await session.open();
    session.pushAudio(Buffer.alloc(3_200, 11), 100);
    await server.waitForAudioFrames(0, 1);
    session.commitAudioThrough(100);
    server.terminate(0);
    await waitFor(() => events.some((event) => (
      event.type === "state" && event.state === "reconnecting"
    )));

    session.pushAudio(Buffer.alloc(3_200, 22), 200);
    await server.waitForConnections(2);
    const forwarded = await server.waitForAudioFrames(1, 1);
    const firstBytes = forwarded
      .map(readAudioData)
      .filter((value): value is Buffer => value !== null)
      .map((audio) => audio[0]);
    assert.deepEqual(firstBytes, [22]);
  } finally {
    await session.close();
    await server.close();
  }
});

test("reports unsent buffered audio instead of silently flushing it", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamStreamingSession(
    "test-key",
    {
      sessionId: "stream-undrained",
      source: "hi",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    {
      endpoint,
      drainTimeoutMs: 30,
      maxReconnectAttempts: 0,
    },
  );

  try {
    await session.open();
    server.terminate(0);
    await waitFor(() => events.some((event) => event.type === "error"));
    session.pushAudio(Buffer.alloc(3_200, 7), 100);

    await assert.rejects(
      session.flush(),
      /could not send \d+ buffered audio bytes/,
    );
  } finally {
    await session.close();
    await server.close();
  }
});

test("requires a post-flush transcript before completing speech flush", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint();
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamStreamingSession(
    "test-key",
    {
      sessionId: "stream-flush-barrier",
      source: "hi",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    { endpoint, flushTimeoutMs: 60 },
  );

  try {
    await session.open();
    const speech = Buffer.alloc(3_200);
    for (let index = 0; index < speech.length; index += 2) {
      speech.writeInt16LE(4_000, index);
    }
    session.pushAudio(speech, 100);
    await server.waitForAudioFrames(0, 1);

    server.send(0, {
      type: "events",
      data: { signal_type: "START_SPEECH" },
    });
    server.send(0, {
      type: "data",
      data: { transcript: "partial before flush" },
    });
    await waitFor(() => events.some((event) => (
      event.type === "transcript" && event.text === "partial before flush"
    )));

    const incompleteFlush = session.flush();
    await server.waitForFlush(0);
    // END_SPEECH alone must not complete flush when only pre-flush text exists.
    server.send(0, {
      type: "events",
      data: { signal_type: "END_SPEECH" },
    });
    await assert.rejects(incompleteFlush, /timed out waiting for final speech/);

    server.send(0, {
      type: "events",
      data: { signal_type: "START_SPEECH" },
    });
    const completeFlush = session.flush();
    await server.waitForFlush(0);
    server.send(0, {
      type: "data",
      data: { transcript: "final after flush" },
    });
    server.send(0, {
      type: "events",
      data: { signal_type: "END_SPEECH" },
    });
    await completeFlush;
  } finally {
    await session.close();
    await server.close();
  }
});

test("rejects a speech flush when no final provider event arrives", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint();
  const session = new SarvamStreamingSession(
    "test-key",
    {
      sessionId: "stream-flush-timeout",
      source: "hi",
      sampleRate: 16_000,
      channels: 1,
      onEvent: () => undefined,
    },
    { endpoint, flushTimeoutMs: 30 },
  );

  try {
    await session.open();
    const speech = Buffer.alloc(3_200);
    for (let index = 0; index < speech.length; index += 2) {
      speech.writeInt16LE(4_000, index);
    }
    session.pushAudio(speech, 100);
    await server.waitForAudioFrames(0, 1);

    await assert.rejects(
      session.flush(),
      /timed out waiting for final speech/,
    );
  } finally {
    await session.close();
    await server.close();
  }
});

function readAudioData(value: unknown): Buffer | null {
  if (
    typeof value !== "object"
    || value === null
    || !("audio" in value)
    || typeof value.audio !== "object"
    || value.audio === null
    || !("data" in value.audio)
    || typeof value.audio.data !== "string"
  ) return null;
  return Buffer.from(value.audio.data, "base64");
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for Sarvam stream state");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
