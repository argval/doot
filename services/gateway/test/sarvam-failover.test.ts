import assert from "node:assert/strict";
import test from "node:test";
import type {
  OpenProviderSessionOptions,
  ProviderStreamEvent,
} from "../src/speech/contract.js";
import { SarvamFailoverSession } from "../src/speech/sarvam/failover.js";
import { FakeSarvamServer, waitForCondition } from "./fake-sarvam.js";

test("falls back to legacy streaming when Realtime cannot open", async () => {
  const server = new FakeSarvamServer({
    rejectPaths: ["/speech-to-text-realtime/ws"],
  });
  const realtimeEndpoint = await server.endpoint("/speech-to-text-realtime/ws");
  const legacyEndpoint = await server.endpoint("/speech-to-text/ws");
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamFailoverSession(
    "test-key",
    options(events),
    {
      realtime: { endpoint: realtimeEndpoint, connectTimeoutMs: 200 },
      legacy: { endpoint: legacyEndpoint, softFlushMs: 0 },
    },
  );

  try {
    await session.open();
    await server.waitForConnections(1);
    const request = server.connections[0]?.request;
    assert.ok(request);
    assert.equal(
      new URL(request.url ?? "", legacyEndpoint).pathname,
      "/speech-to-text/ws",
    );
    assert.ok(events.some((event) => (
      event.type === "warning" && /legacy streaming/i.test(event.message)
    )));

    session.pushAudio(Buffer.alloc(3_200, 17), 100);
    await server.waitForAudioFrames(0, 1);
  } finally {
    await session.close();
    await server.close();
  }
});

test("fails over to legacy streaming after a fatal Realtime error and replays audio", async () => {
  const server = new FakeSarvamServer();
  const realtimeEndpoint = await server.endpoint("/speech-to-text-realtime/ws");
  const legacyEndpoint = await server.endpoint("/speech-to-text/ws");
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamFailoverSession(
    "test-key",
    options(events),
    {
      realtime: {
        endpoint: realtimeEndpoint,
        reconnectBaseDelayMs: 10,
        maxReconnectDelayMs: 20,
      },
      legacy: { endpoint: legacyEndpoint, softFlushMs: 0 },
    },
  );

  try {
    await session.open();
    session.pushAudio(Buffer.alloc(3_200, 27), 100);
    await waitForCondition(() => Boolean(
      server.connections[0]?.messages.some(isRealtimeAudioInput),
    ));
    server.send(0, {
      event: "error",
      code: "REALTIME_UNAVAILABLE",
      is_fatal: true,
      message: "Realtime is unavailable for this account",
    });

    await server.waitForConnections(2);
    const legacyRequest = server.connections[1]?.request;
    assert.ok(legacyRequest);
    assert.equal(
      new URL(legacyRequest.url ?? "", legacyEndpoint).pathname,
      "/speech-to-text/ws",
    );
    const audio = await server.waitForAudioFrames(1, 1);
    assert.equal(readLegacyAudioByte(audio[0]), 27);
    assert.ok(events.some((event) => (
      event.type === "warning" && /switched to legacy/i.test(event.message)
    )));
  } finally {
    await session.close();
    await server.close();
  }
});

test("buffers all bounded audio received during a Realtime to legacy handoff", async () => {
  const server = new FakeSarvamServer({
    acceptDelayMsByPath: { "/speech-to-text/ws": 200 },
  });
  const realtimeEndpoint = await server.endpoint("/speech-to-text-realtime/ws");
  const legacyEndpoint = await server.endpoint("/speech-to-text/ws");
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamFailoverSession(
    "test-key",
    options(events),
    {
      realtime: { endpoint: realtimeEndpoint },
      legacy: { endpoint: legacyEndpoint, softFlushMs: 0 },
    },
  );

  try {
    await session.open();
    session.pushAudio(Buffer.alloc(3_200, 1), 100);
    await waitForCondition(() => Boolean(
      server.connections[0]?.messages.some(isRealtimeAudioInput),
    ));
    server.send(0, {
      event: "error",
      code: "REALTIME_UNAVAILABLE",
      is_fatal: true,
      message: "Realtime is unavailable for this account",
    });
    await waitForCondition(() => events.some((event) => (
      event.type === "state" && event.state === "closed"
    )));

    for (let index = 2; index <= 12; index += 1) {
      session.pushAudio(Buffer.alloc(3_200, index), index * 100);
    }
    await server.waitForConnections(2);
    const audio = await server.waitForAudioFrames(1, 12);
    assert.deepEqual(audio.map(readLegacyAudioByte), [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  } finally {
    await session.close();
    await server.close();
  }
});

test("fails over when Realtime ends the session without a client end request", async () => {
  const server = new FakeSarvamServer();
  const realtimeEndpoint = await server.endpoint("/speech-to-text-realtime/ws");
  const legacyEndpoint = await server.endpoint("/speech-to-text/ws");
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamFailoverSession(
    "test-key",
    options(events),
    {
      realtime: { endpoint: realtimeEndpoint },
      legacy: { endpoint: legacyEndpoint, softFlushMs: 0 },
    },
  );

  try {
    await session.open();
    server.send(0, { event: "session.end", audio_duration_s: 0.1 });
    await server.waitForConnections(2);
    const legacyRequest = server.connections[1]?.request;
    assert.ok(legacyRequest);
    assert.equal(
      new URL(legacyRequest.url ?? "", legacyEndpoint).pathname,
      "/speech-to-text/ws",
    );
    assert.ok(events.some((event) => (
      event.type === "warning" && /switched to legacy/i.test(event.message)
    )));
  } finally {
    await session.close();
    await server.close();
  }
});

function options(events: ProviderStreamEvent[]): OpenProviderSessionOptions {
  return {
    sessionId: "failover-1",
    source: "kn" as const,
    sampleRate: 16_000,
    channels: 1,
    onEvent: (event: ProviderStreamEvent) => {
      events.push(event);
    },
  };
}

function isRealtimeAudioInput(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "event" in value
    && value.event === "audio_input";
}

function readLegacyAudioByte(value: unknown): number | undefined {
  if (
    typeof value !== "object"
    || value === null
    || !("audio" in value)
    || typeof value.audio !== "object"
    || value.audio === null
    || !("data" in value.audio)
    || typeof value.audio.data !== "string"
  ) return undefined;
  return Buffer.from(value.audio.data, "base64")[0];
}
