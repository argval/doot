import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import type { ProviderStreamEvent } from "../src/speech/contract.js";
import { OpenAITranscribeSession, upsamplePcm16To24k } from "../src/speech/openai/realtime.js";

test("converts 16 kHz PCM, configures OpenAI VAD, and reconciles a completed turn", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const endpoint = `ws://127.0.0.1:${address.port}/v1/realtime?model=gpt-live-transcribe`;
  const events: ProviderStreamEvent[] = [];
  const messages: Array<Record<string, unknown>> = [];
  let socket: WebSocket | undefined;
  let authorization: string | string[] | undefined;
  server.on("connection", (connection, request) => {
    socket = connection;
    authorization = request.headers.authorization;
    connection.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "session.update") connection.send(JSON.stringify({ type: "session.updated" }));
    });
  });

  const session = new OpenAITranscribeSession("test-key", {
    sessionId: "openai-1", source: "es", target: "es", sampleRate: 16_000, channels: 1,
    onEvent: (event) => events.push(event),
  }, { endpoint, setupTimeoutMs: 250, endTimeoutMs: 250 });
  try {
    await session.open();
    assert.equal(authorization, "Bearer test-key");
    assert.deepEqual(messages[0], {
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "gpt-live-transcribe", delay: "low", languages: ["es"] },
            turn_detection: { type: "server_vad", prefix_padding_ms: 100, silence_duration_ms: 300 },
          },
        },
      },
    });

    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(0, 0); pcm.writeInt16LE(6_000, 2);
    session.pushAudio(pcm, 100);
    const append = await eventually(() => messages.find((message) => message.type === "input_audio_buffer.append"));
    assert.deepEqual(Buffer.from(append.audio as string, "base64"), upsamplePcm16To24k(pcm));

    socket!.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    socket!.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: "item-1", delta: "Hola" }));
    socket!.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "item-1" }));
    socket!.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", transcript: "Hola mundo." }));
    await eventually(() => events.find((event) => event.type === "transcript" && event.isFinal));
    const transcripts = events.filter((event): event is Extract<ProviderStreamEvent, { type: "transcript" }> => event.type === "transcript");
    assert.deepEqual(transcripts.map(({ text, isFinal }) => ({ text, isFinal })), [
      { text: "Hola", isFinal: false },
      { text: "Hola mundo.", isFinal: true },
    ]);
    assert.equal(transcripts[0]?.turnId, transcripts[1]?.turnId);
    assert.ok(events.some((event) => event.type === "speech_end" && event.finalTranscriptPending));
  } finally {
    await session.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("duplicates a trailing PCM16 sample so conversion remains valid", () => {
  const input = Buffer.alloc(2); input.writeInt16LE(-4_000);
  const output = upsamplePcm16To24k(input);
  assert.deepEqual([...output], [...Buffer.from([0x60, 0xf0, 0x60, 0xf0, 0x60, 0xf0])]);
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
