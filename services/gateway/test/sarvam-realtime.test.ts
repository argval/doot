import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderStreamEvent } from "../src/speech/contract.js";
import { SarvamRealtimeSession } from "../src/speech/sarvam/realtime.js";
import { toSarvamRealtimeLanguageCode } from "../src/speech/sarvam/languages.js";
import { FakeSarvamServer, waitForCondition } from "./fake-sarvam.js";

test("uses Realtime-specific auto and Odia language codes", () => {
  assert.equal(toSarvamRealtimeLanguageCode("auto"), "auto");
  assert.equal(toSarvamRealtimeLanguageCode("od"), "or-IN");
});

test("uses the Realtime API protocol and forwards partial and final transcripts", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint("/speech-to-text-realtime/ws");
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamRealtimeSession(
    "test-key",
    {
      sessionId: "realtime-1",
      source: "od",
      target: "en",
      sampleRate: 16_000,
      channels: 1,
      onEvent: (event) => events.push(event),
    },
    { endpoint, endTimeoutMs: 200 },
  );

  try {
    await session.open();
    const request = server.connections[0]?.request;
    assert.ok(request);
    const url = new URL(request.url ?? "", endpoint);
    assert.equal(url.pathname, "/speech-to-text-realtime/ws");
    assert.equal(url.searchParams.get("model"), "saaras:v3-realtime");
    assert.equal(url.searchParams.get("language_code"), "or-IN");
    assert.equal(url.searchParams.get("stream_type"), "balanced");
    assert.equal(url.searchParams.get("mode"), "transcribe");
    assert.equal(url.searchParams.get("endpointing"), "vad");
    assert.equal(url.searchParams.get("encoding"), "linear16");
    assert.equal(url.searchParams.get("sample_rate"), "16000");
    assert.equal(request.headers["api-subscription-key"], "test-key");

    session.pushAudio(Buffer.alloc(3_200, 7), 100);
    await waitForCondition(() => Boolean(
      server.connections[0]?.messages.some(isRealtimeAudioInput),
    ));
    const audioInput = server.connections[0]?.messages.find(isRealtimeAudioInput);
    assert.deepEqual(audioInput, {
      event: "audio_input",
      audio: Buffer.alloc(3_200, 7).toString("base64"),
    });

    server.send(0, { event: "vad.speech_start" });
    server.send(0, {
      event: "transcript.partial",
      text: "ಒಂದು Cursor",
      language: "kn-IN",
    });
    server.send(0, {
      event: "vad.speech_end",
    });
    await waitForCondition(() => events.some((event) => (
      event.type === "speech_end" && event.timestampMs === 200
    )));
    session.pushAudio(Buffer.alloc(3_200, 8), 300);
    await waitForCondition(() => (
      server.connections[0]?.messages.filter(isRealtimeAudioInput).length === 2
    ));
    server.send(0, { event: "vad.speech_start" });
    server.send(0, {
      event: "transcript.partial",
      text: "ಎರಡನೇ turn",
      language: "kn-IN",
    });
    server.send(0, {
      event: "vad.speech_end",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    session.pushAudio(Buffer.alloc(3_200, 9), 500);
    await waitForCondition(() => (
      server.connections[0]?.messages.filter(isRealtimeAudioInput).length === 3
    ));
    server.send(0, { event: "vad.speech_start" });
    server.send(0, {
      event: "transcript.partial",
      text: "ಮೂರನೇ turn",
      language: "kn-IN",
    });
    server.send(0, { event: "vad.speech_end" });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    let flushResolved = false;
    const flush = session.flush().then(() => {
      flushResolved = true;
    });
    await waitForCondition(() => Boolean(
      server.connections[0]?.messages.some(isEndMessage),
    ));
    for (const [index, text] of [
      "ಒಂದು Cursor ಬಳಸಿ",
      "ಎರಡನೇ turn ಮುಗಿದಿದೆ",
      "ಮೂರನೇ turn ಮುಗಿದಿದೆ",
    ].entries()) {
      server.send(0, { event: "transcript.final", text, language: "kn-IN" });
      await waitForCondition(() => events.filter((event) => (
        event.type === "transcript" && event.isFinal
      )).length === index + 1);
      if (index < 2) assert.equal(flushResolved, false);
    }
    await flush;
    assert.equal(flushResolved, true);
    assert.equal(events.filter((event) => (
      event.type === "transcript" && event.isFinal
    )).length, 3);

    assert.ok(events.some((event) => (
      event.type === "speech_start" && event.timestampMs === 100
    )));
    assert.ok(events.some((event) => (
      event.type === "transcript"
      && event.text === "ಒಂದು Cursor"
      && event.languageCode === "kn-IN"
      && event.isFinal === false
    )));
    assert.ok(events.some((event) => (
      event.type === "transcript"
      && event.text === "ಒಂದು Cursor ಬಳಸಿ"
      && event.isFinal === true
    )));
    assert.ok(events.some((event) => (
      event.type === "speech_end" && event.timestampMs === 200
    )));
    const starts = events.filter((event) => event.type === "speech_start");
    const firstFinal = events.find((event) => (
      event.type === "transcript" && event.text === "ಒಂದು Cursor ಬಳಸಿ"
    ));
    const secondPartial = events.find((event) => (
      event.type === "transcript" && event.text === "ಎರಡನೇ turn"
    ));
    const secondFinal = events.find((event) => (
      event.type === "transcript" && event.text === "ಎರಡನೇ turn ಮುಗಿದಿದೆ"
    ));
    const thirdPartial = events.find((event) => (
      event.type === "transcript" && event.text === "ಮೂರನೇ turn"
    ));
    assert.equal(starts.length, 3);
    assert.ok(firstFinal?.type === "transcript");
    assert.ok(secondPartial?.type === "transcript");
    assert.ok(secondFinal?.type === "transcript");
    assert.ok(thirdPartial?.type === "transcript");
    assert.equal(firstFinal.timestampMs, 200);
    assert.equal(firstFinal.turnId, starts[0]?.turnId);
    assert.equal(secondPartial.timestampMs, 400);
    assert.equal(secondPartial.turnId, starts[1]?.turnId);
    assert.equal(secondFinal.turnId, starts[1]?.turnId);
    assert.equal(thirdPartial.timestampMs, 600);
    assert.equal(thirdPartial.turnId, starts[2]?.turnId);
    assert.ok(events.indexOf(firstFinal) < events.indexOf(starts[1]!));
    assert.ok(events.indexOf(secondFinal) < events.indexOf(starts[2]!));

  } finally {
    await session.close();
    await server.close();
  }
});

test("replays recent audio through Realtime after a transient disconnect", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint("/speech-to-text-realtime/ws");
  const events: ProviderStreamEvent[] = [];
  const session = new SarvamRealtimeSession(
    "test-key",
    {
      sessionId: "realtime-reconnect",
      source: "hi",
      target: "en",
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
    await waitForCondition(() => Boolean(
      server.connections[0]?.messages.some(isRealtimeAudioInput),
    ));
    server.terminate(0);
    await waitForCondition(() => events.some((event) => event.type === "warning"));

    session.pushAudio(Buffer.alloc(3_200, 22), 200);
    await server.waitForConnections(2);
    await waitForCondition(() => (
      server.connections[1]?.messages.filter(isRealtimeAudioInput).length ?? 0
    ) >= 2);
    const forwarded = server.connections[1]?.messages
      .filter(isRealtimeAudioInput)
      .map((message) => Buffer.from(message.audio, "base64")[0]);
    assert.deepEqual(forwarded, [11, 22]);
  } finally {
    await session.close();
    await server.close();
  }
});

test("sends documented Realtime ping keepalives", async () => {
  const server = new FakeSarvamServer();
  const endpoint = await server.endpoint("/speech-to-text-realtime/ws");
  const session = new SarvamRealtimeSession(
    "test-key",
    {
      sessionId: "realtime-ping",
      source: "en",
      target: "hi",
      sampleRate: 16_000,
      channels: 1,
      onEvent: () => undefined,
    },
    { endpoint, pingIntervalMs: 10 },
  );

  try {
    await session.open();
    await waitForCondition(() => Boolean(
      server.connections[0]?.messages.some((message) => (
        typeof message === "object"
        && message !== null
        && "event" in message
        && message.event === "ping"
      )),
    ));
  } finally {
    await session.close();
    await server.close();
  }
});

function isRealtimeAudioInput(
  value: unknown,
): value is { event: "audio_input"; audio: string } {
  return typeof value === "object"
    && value !== null
    && "event" in value
    && value.event === "audio_input"
    && "audio" in value
    && typeof value.audio === "string";
}

function isEndMessage(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "event" in value
    && value.event === "end";
}
