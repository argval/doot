import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { ProviderStreamEvent } from "../src/speech/contract.js";
import { SpeechmaticsRealtimeSession } from "../src/speech/speechmatics/realtime.js";

test("streams PCM16 and turns Speechmatics partials and finals into one caption turn", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const endpoint = `ws://127.0.0.1:${address.port}/v2`;
  const events: ProviderStreamEvent[] = [];
  let socket: WebSocket | undefined;
  let authorization: string | string[] | undefined;
  const messages: Array<unknown> = [];
  server.on("connection", (connection, request) => {
    socket = connection;
    authorization = request.headers.authorization;
    connection.on("message", (raw, isBinary) => {
      messages.push(isBinary ? raw : JSON.parse(raw.toString()));
      if (!isBinary) connection.send(JSON.stringify({ message: "RecognitionStarted" }));
    });
  });

  const session = new SpeechmaticsRealtimeSession("test-key", {
    sessionId: "speechmatics-1", source: "zh", target: "zh", sampleRate: 16_000, channels: 1,
    onEvent: (event) => events.push(event),
  }, { endpoint, setupTimeoutMs: 250, endTimeoutMs: 250 });

  try {
    await session.open();
    assert.equal(authorization, "Bearer test-key");
    assert.deepEqual(messages[0], {
      message: "StartRecognition",
      audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 16_000 },
      transcription_config: { language: "cmn", enable_partials: true, max_delay: 1 },
    });

    session.pushAudio(Buffer.alloc(3_200, 7), 100);
    await eventually(() => messages.find(Buffer.isBuffer));
    socket!.send(JSON.stringify({ message: "AddPartialTranscript", metadata: { transcript: "你好" } }));
    socket!.send(JSON.stringify({ message: "AddTranscript", metadata: { transcript: "你好，世界。" } }));
    await eventually(() => events.find((event) => event.type === "speech_end"));
    const transcripts = events.filter((event): event is Extract<ProviderStreamEvent, { type: "transcript" }> => event.type === "transcript");
    assert.deepEqual(transcripts.map(({ text, isFinal }) => ({ text, isFinal })), [
      { text: "你好", isFinal: false },
      { text: "你好，世界。", isFinal: true },
    ]);
    assert.equal(transcripts[0]?.turnId, transcripts[1]?.turnId);
    assert.equal(events.filter((event) => event.type === "speech_start").length, 1);

    const flushing = session.flush();
    await eventually(() => messages.find((message) => !Buffer.isBuffer(message) && (message as { message?: string }).message === "EndOfStream"));
    socket!.send(JSON.stringify({ message: "EndOfTranscript" }));
    await flushing;
  } finally {
    await session.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function eventually<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for test event");
}
