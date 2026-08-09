import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIO_SAMPLE_RATES,
  CHANNEL_COUNTS,
  SUPPORTED_LANGUAGES,
  type ServerMessage,
} from "@doot/protocol";
import WebSocket from "ws";
import { ProviderRouter } from "../src/speech/router.js";
import type {
  OpenProviderSessionOptions,
  ProviderStreamEvent,
  ProviderStreamSession,
  SpeechProvider,
} from "../src/speech/contract.js";
import { buildServer } from "../src/server.js";
import {
  TranslationUnavailableError,
  type TranslationRequest,
} from "../src/translation/contract.js";

test("closes a provider session that opens after its client disconnected", async () => {
  const provider = new DelayedProvider();
  const translator = new RecordingTranslator();
  const app = await buildServer(
    new ProviderRouter([provider]),
    (request) => translator.translate(request),
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = await RealtimeClient.connect(
    address.replace("http", "ws") + "/v1/realtime",
  );

  try {
    client.send({
      type: "start_session",
      sessionId: "abandoned-session",
      sourceLanguage: "kn",
      targetLanguage: "en",
      provider: "mock",
      sampleRate: 16_000,
      channels: 1,
    });
    await waitFor(() => (
      provider.sessions.length === 1 ? true : undefined
    ));
    await client.close();
    provider.release();
    await waitFor(() => (
      provider.sessions[0]?.closeCalls === 1 ? true : undefined
    ));
  } finally {
    provider.release();
    await client.close();
    await app.close();
  }
});

test("suppresses delayed translations from a replaced session generation", async () => {
  const provider = new ControlledProvider();
  const translator = new DeferredTranslator();
  const app = await buildServer(
    new ProviderRouter([provider]),
    (request) => translator.translate(request),
    { utteranceGraceMs: 5 },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = await RealtimeClient.connect(
    address.replace("http", "ws") + "/v1/realtime",
  );
  const start = {
    type: "start_session",
    sessionId: "replacement-session",
    sourceLanguage: "kn",
    targetLanguage: "en",
    provider: "mock",
    sampleRate: 16_000,
    channels: 1,
  };

  try {
    client.send(start);
    await client.waitForMessage((message) => message.type === "session_started");
    const first = provider.sessions[0]!;
    first.emit({ type: "speech_start", timestampMs: 100 });
    first.emit({
      type: "transcript",
      text: "stale source",
      timestampMs: 150,
      isFinal: false,
    });
    first.emit({ type: "speech_end", timestampMs: 180 });
    await waitFor(() => (
      translator.requests.length === 1 ? true : undefined
    ));

    client.send(start);
    await waitFor(() => (
      provider.sessions.length === 2 ? true : undefined
    ));
    translator.resolveNext("stale translation");
    await delay(20);

    assert.equal(
      client.messages.filter(
        (message) => message.type === "caption" && message.isFinal,
      ).length,
      0,
    );
  } finally {
    translator.resolveNext("cleanup");
    await client.close();
    await app.close();
  }
});

test("opens one provider stream and forwards every desktop audio frame", async () => {
  const harness = await createHarness();
  try {
    assert.equal(harness.provider.sessions.length, 1);
    harness.client.sendAudio(0, 100, Buffer.alloc(3_200, 1));
    harness.client.sendAudio(1, 200, Buffer.alloc(3_200, 2));
    await waitFor(() => (
      harness.provider.sessions[0]?.audio.length === 2 ? true : undefined
    ));

    assert.equal(harness.provider.sessions.length, 1);
    assert.deepEqual(
      harness.provider.sessions[0]?.audio.map((frame) => frame.timestampMs),
      [100, 200],
    );
  } finally {
    await harness.close();
  }
});

test("coalesces a short pause when START_SPEECH cancels the grace timer", async () => {
  const harness = await createHarness(50);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({ type: "speech_start", timestampMs: 100 });
    stream.emit({
      type: "transcript",
      text: "ನಾನು Cursor",
      timestampMs: 200,
      languageCode: "kn-IN",
      isFinal: false,
    });
    stream.emit({ type: "speech_end", timestampMs: 220 });
    await delay(10);
    stream.emit({ type: "speech_start", timestampMs: 230 });
    stream.emit({
      type: "transcript",
      text: "use ಮಾಡುತ್ತೇನೆ 42",
      timestampMs: 300,
      languageCode: "kn-IN",
      isFinal: false,
    });
    stream.emit({ type: "speech_end", timestampMs: 320 });

    const final = await harness.client.waitForMessage(
      (message) => message.type === "caption" && message.isFinal,
    );
    assert.equal(final.type, "caption");
    assert.equal(final.sourceText, "ನಾನು Cursor use ಮಾಡುತ್ತೇನೆ 42");
    assert.equal(final.translatedText, "English: ನಾನು Cursor use ಮಾಡುತ್ತೇನೆ 42");
    assert.equal(final.revision, 3);
    assert.equal(harness.translator.requests.length, 1);
    assert.match(final.translatedText, /Cursor/);
    assert.match(final.translatedText, /42/);

    const partials = harness.client.messages.filter(
      (message) => message.type === "caption" && !message.isFinal,
    );
    assert.equal(partials.length, 2);
    assert.ok(partials.every((partial) => (
      partial.type === "caption" && partial.utteranceId === final.utteranceId
    )));
  } finally {
    await harness.close();
  }
});

test("finalizes separate utterances after a long VAD pause", async () => {
  const harness = await createHarness(25);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({ type: "speech_start", timestampMs: 100 });
    stream.emit({
      type: "transcript",
      text: "ಮೊದಲ ವಾಕ್ಯ",
      timestampMs: 150,
      isFinal: false,
    });
    stream.emit({ type: "speech_end", timestampMs: 180 });
    await harness.client.waitForFinalCount(1);

    stream.emit({ type: "speech_start", timestampMs: 1_000 });
    stream.emit({
      type: "transcript",
      text: "second sentence",
      timestampMs: 1_100,
      isFinal: false,
    });
    stream.emit({ type: "speech_end", timestampMs: 1_200 });
    const finals = await harness.client.waitForFinalCount(2);

    assert.notEqual(finals[0]?.utteranceId, finals[1]?.utteranceId);
    assert.deepEqual(
      finals.map((caption) => caption.sourceText),
      ["ಮೊದಲ ವಾಕ್ಯ", "second sentence"],
    );
    assert.equal(harness.translator.requests.length, 2);
  } finally {
    await harness.close();
  }
});

test("publishes draft translations during continuous speech without a pause", async () => {
  const harness = await createHarness(2_000);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({ type: "speech_start", timestampMs: 100 });
    stream.emit({ type: "transcript", text: "first", timestampMs: 150, isFinal: false });
    await delay(80);
    stream.emit({
      type: "transcript",
      text: "first second",
      timestampMs: 250,
      isFinal: false,
    });
    await delay(80);
    stream.emit({
      type: "transcript",
      text: "first second third",
      timestampMs: 350,
      isFinal: false,
    });

    const draft = await harness.client.waitForMessage(
      (message) => (
        message.type === "caption"
        && !message.isFinal
        && message.translatedText.startsWith("English:")
      ),
    );
    assert.equal(draft.type, "caption");
    assert.match(draft.translatedText, /^English:/);
    assert.ok(harness.translator.requests.length >= 1);
  } finally {
    await harness.close();
  }
});

test("publishes a draft translation before the utterance finalizes", async () => {
  const harness = await createHarness(400);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({ type: "speech_start", timestampMs: 100 });
    stream.emit({
      type: "transcript",
      text: "draft me soon",
      timestampMs: 150,
      isFinal: false,
    });

    const draft = await harness.client.waitForMessage(
      (message) => (
        message.type === "caption"
        && !message.isFinal
        && message.translatedText.startsWith("English:")
      ),
    );
    assert.equal(draft.type, "caption");
    assert.equal(draft.sourceText, "draft me soon");
    assert.equal(draft.translatedText, "English: draft me soon");
    assert.ok(harness.translator.requests.length >= 1);

    stream.emit({ type: "speech_end", timestampMs: 180 });
    const finals = await harness.client.waitForFinalCount(1);
    assert.equal(finals[0]?.translatedText, "English: draft me soon");
  } finally {
    await harness.close();
  }
});

test("finalizes promptly when Realtime sends transcript.final before VAD speech_end", async () => {
  const harness = await createHarness(2_000);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({ type: "speech_start", timestampMs: 100 });
    stream.emit({
      type: "transcript",
      text: "Realtime partial",
      timestampMs: 150,
      isFinal: false,
    });
    stream.emit({
      type: "transcript",
      text: "Realtime final transcript",
      timestampMs: 220,
      isFinal: true,
    });

    const final = await harness.client.waitForMessage(
      (message) => message.type === "caption" && message.isFinal,
    );
    assert.equal(final.type, "caption");
    assert.equal(final.sourceText, "Realtime final transcript");
    assert.equal(final.translatedText, "English: Realtime final transcript");
  } finally {
    await harness.close();
  }
});

test("merges overlapping transcript text across a provider reconnect", async () => {
  const harness = await createHarness(20);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({ type: "speech_start", timestampMs: 100 });
    stream.emit({
      type: "transcript",
      text: "hello world",
      timestampMs: 150,
      isFinal: false,
    });
    stream.emit({ type: "state", state: "reconnecting" });
    stream.emit({ type: "state", state: "open" });
    stream.emit({
      type: "transcript",
      text: "world again",
      timestampMs: 200,
      isFinal: false,
    });
    stream.emit({ type: "speech_end", timestampMs: 220 });

    const finals = await harness.client.waitForFinalCount(1);
    assert.equal(finals[0]?.sourceText, "hello world again");
  } finally {
    await harness.close();
  }
});

test("merges Realtime partial overlap despite casing and punctuation changes", async () => {
  const harness = await createHarness(2_000);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({ type: "speech_start", timestampMs: 100 });
    stream.emit({
      type: "transcript",
      text: "Doot, captions",
      timestampMs: 150,
      isFinal: false,
    });
    stream.emit({
      type: "transcript",
      text: "Captions are working",
      timestampMs: 220,
      isFinal: false,
    });

    const latest = await harness.client.waitForMessage(
      (message) => (
        message.type === "caption"
        && !message.isFinal
        && message.sourceText === "Doot, captions are working"
      ),
    );
    assert.equal(latest.type, "caption");
  } finally {
    await harness.close();
  }
});

test("publishes target-only end-to-end deltas without corrupting source text", async () => {
  const harness = await createHarness(2_000);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({
      type: "transcript",
      text: "",
      translatedText: "Hello",
      timestampMs: 100,
      isFinal: false,
    });
    const partial = await harness.client.waitForMessage((message) => (
      message.type === "caption"
      && !message.isFinal
      && message.translatedText === "Hello"
    ));
    assert.equal(partial.type, "caption");
    assert.equal(partial.sourceText, "");

    stream.emit({
      type: "transcript",
      text: "Hola",
      translatedText: "Hello",
      timestampMs: 120,
      isFinal: true,
    });
    const firstFinal = await harness.client.waitForMessage((message) => (
      message.type === "caption"
      && message.isFinal
      && message.translatedText === "Hello"
    ));
    assert.equal(firstFinal.type, "caption");
    assert.equal(firstFinal.sourceText, "Hola");

    stream.emit({
      type: "transcript",
      text: "Adiós",
      translatedText: "Goodbye",
      timestampMs: 220,
      isFinal: true,
    });
    const finals = await harness.client.waitForFinalCount(2);
    assert.equal(finals[1]?.sourceText, "Adiós");
    assert.equal(finals[1]?.translatedText, "Goodbye");
    assert.notEqual(finals[0]?.utteranceId, finals[1]?.utteranceId);
    assert.equal(harness.translator.requests.length, 0);
  } finally {
    await harness.close();
  }
});

test("finalizes an unchanged end-to-end transcript before the next utterance", async () => {
  const harness = await createHarness(2_000);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({
      type: "transcript",
      text: "Hola",
      translatedText: "Hello",
      timestampMs: 100,
      isFinal: false,
    });
    await harness.client.waitForMessage((message) => (
      message.type === "caption"
      && !message.isFinal
      && message.translatedText === "Hello"
    ));

    stream.emit({
      type: "transcript",
      text: "Hola",
      translatedText: "Hello",
      timestampMs: 120,
      isFinal: true,
    });
    const firstFinal = await harness.client.waitForMessage((message) => (
      message.type === "caption"
      && message.isFinal
      && message.translatedText === "Hello"
    ));

    stream.emit({
      type: "transcript",
      text: "Adiós",
      translatedText: "Goodbye",
      timestampMs: 220,
      isFinal: true,
    });
    const finals = await harness.client.waitForFinalCount(2);
    assert.equal(firstFinal.type, "caption");
    assert.notEqual(firstFinal.utteranceId, finals[1]?.utteranceId);
    assert.equal(finals[1]?.sourceText, "Adiós");
  } finally {
    await harness.close();
  }
});

test("commits finalized audio so provider recovery does not replay it", async () => {
  const harness = await createHarness(20);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.emit({ type: "speech_start", timestampMs: 100 });
    stream.emit({
      type: "transcript",
      text: "replayed phrase",
      timestampMs: 150,
      isFinal: false,
    });
    stream.emit({ type: "speech_end", timestampMs: 180 });
    await harness.client.waitForFinalCount(1);

    assert.deepEqual(stream.committedThrough, [180]);
  } finally {
    await harness.close();
  }
});

test("flushes, translates, and emits the final caption before session_stopped", async () => {
  const harness = await createHarness(50);
  try {
    const stream = harness.provider.sessions[0]!;
    stream.onFlush = () => {
      stream.emit({ type: "speech_start", timestampMs: 500 });
      stream.emit({
        type: "transcript",
        text: "stop time transcript",
        timestampMs: 600,
        isFinal: false,
      });
      stream.emit({ type: "speech_end", timestampMs: 620 });
    };

    harness.client.send({
      type: "stop_session",
      sessionId: harness.sessionId,
    });
    await harness.client.waitForMessage(
      (message) => message.type === "session_stopped",
    );

    const finalIndex = harness.client.messages.findIndex(
      (message) => message.type === "caption" && message.isFinal,
    );
    const stoppedIndex = harness.client.messages.findIndex(
      (message) => message.type === "session_stopped",
    );
    assert.ok(finalIndex >= 0);
    assert.ok(stoppedIndex > finalIndex);
    assert.equal(stream.flushCalls, 1);
    assert.equal(stream.closeCalls, 1);
  } finally {
    await harness.close();
  }
});

test("never substitutes source text when translation is unavailable", async () => {
  const provider = new ControlledProvider();
  const app = await buildServer(
    new ProviderRouter([provider]),
    async (request) => {
      throw new TranslationUnavailableError(request);
    },
    { utteranceGraceMs: 5 },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = await RealtimeClient.connect(
    address.replace("http", "ws") + "/v1/realtime",
  );

  try {
    client.send({
      type: "start_session",
      sessionId: "translation-unavailable",
      sourceLanguage: "de",
      targetLanguage: "en",
      provider: "mock",
      sampleRate: 16_000,
      channels: 1,
    });
    await client.waitForMessage((message) => message.type === "session_started");
    provider.sessions[0]?.emit({
      type: "transcript",
      text: "Hallo Welt",
      timestampMs: 100,
      isFinal: true,
    });

    const error = await client.waitForMessage((message) => (
      message.type === "error" && message.code === "TRANSLATION_UNAVAILABLE"
    ));
    const caption = await client.waitForMessage((message) => (
      message.type === "caption" && message.isFinal
    ));
    assert.equal(error.type, "error");
    assert.equal(error.retryable, false);
    assert.equal(caption.type, "caption");
    assert.equal(caption.sourceText, "Hallo Welt");
    assert.equal(caption.translatedText, "");
  } finally {
    await client.close();
    await app.close();
  }
});

interface Harness {
  sessionId: string;
  provider: ControlledProvider;
  translator: RecordingTranslator;
  client: RealtimeClient;
  close(): Promise<void>;
}

async function createHarness(utteranceGraceMs = 25): Promise<Harness> {
  const sessionId = `test-${Math.random().toString(16).slice(2)}`;
  const provider = new ControlledProvider();
  const translator = new RecordingTranslator();
  const router = new ProviderRouter([provider]);
  const app = await buildServer(
    router,
    (request) => translator.translate(request),
    { utteranceGraceMs, maxUtteranceMs: 5_000 },
  );
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = await RealtimeClient.connect(
    address.replace("http", "ws") + "/v1/realtime",
  );
  client.send({
    type: "start_session",
    sessionId,
    sourceLanguage: "kn",
    targetLanguage: "en",
    provider: "mock",
    sampleRate: 16_000,
    channels: 1,
  });
  await client.waitForMessage((message) => message.type === "session_started");

  return {
    sessionId,
    provider,
    translator,
    client,
    close: async () => {
      await client.close();
      await app.close();
    },
  };
}

class ControlledProvider implements SpeechProvider {
  readonly id = "mock" as const;
  readonly configured = true;
  readonly capabilities = {
    sourceLanguages: SUPPORTED_LANGUAGES,
    sampleRates: AUDIO_SAMPLE_RATES,
    channels: CHANNEL_COUNTS,
    automaticLanguageDetection: true,
    partialTranscripts: true,
    routingPriority: 100,
    automaticDetectionPriority: 100,
  } as const;
  readonly sessions: ControlledSession[] = [];

  async openSession(options: OpenProviderSessionOptions): Promise<ProviderStreamSession> {
    const session = new ControlledSession(options);
    this.sessions.push(session);
    return session;
  }
}

class DelayedProvider implements SpeechProvider {
  readonly id = "mock" as const;
  readonly configured = true;
  readonly capabilities = {
    sourceLanguages: SUPPORTED_LANGUAGES,
    sampleRates: AUDIO_SAMPLE_RATES,
    channels: CHANNEL_COUNTS,
    automaticLanguageDetection: true,
    partialTranscripts: true,
    routingPriority: 100,
    automaticDetectionPriority: 100,
  } as const;
  readonly sessions: ControlledSession[] = [];
  private releaseOpen: (() => void) | null = null;

  openSession(options: OpenProviderSessionOptions): Promise<ProviderStreamSession> {
    const session = new ControlledSession(options);
    this.sessions.push(session);
    return new Promise((resolve) => {
      this.releaseOpen = () => resolve(session);
    });
  }

  release(): void {
    this.releaseOpen?.();
    this.releaseOpen = null;
  }
}

class ControlledSession implements ProviderStreamSession {
  readonly audio: Array<{ audio: Buffer; timestampMs: number }> = [];
  readonly committedThrough: number[] = [];
  flushCalls = 0;
  closeCalls = 0;
  onFlush: (() => void) | null = null;

  constructor(private readonly options: OpenProviderSessionOptions) {}

  pushAudio(audio: Uint8Array, timestampMs: number): void {
    this.audio.push({ audio: Buffer.from(audio), timestampMs });
  }

  commitAudioThrough(timestampMs: number): void {
    this.committedThrough.push(timestampMs);
  }

  async flush(): Promise<void> {
    this.flushCalls += 1;
    this.onFlush?.();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  emit(event: ProviderStreamEvent): void {
    this.options.onEvent(event);
  }
}

class RecordingTranslator {
  readonly requests: TranslationRequest[] = [];

  async translate(request: TranslationRequest): Promise<string> {
    this.requests.push(request);
    return `English: ${request.text}`;
  }
}

class DeferredTranslator {
  readonly requests: TranslationRequest[] = [];
  private readonly resolvers: Array<(text: string) => void> = [];

  translate(request: TranslationRequest): Promise<string> {
    this.requests.push(request);
    return new Promise((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  resolveNext(text: string): void {
    this.resolvers.shift()?.(text);
  }
}

class RealtimeClient {
  readonly messages: ServerMessage[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.messages.push(JSON.parse(raw.toString()) as ServerMessage);
    });
  }

  static async connect(url: string): Promise<RealtimeClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new RealtimeClient(socket);
  }

  send(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }

  sendAudio(sequence: number, timestampMs: number, audio: Buffer): void {
    const sessionStarted = this.messages.find(
      (message) => message.type === "session_started",
    );
    if (!sessionStarted || sessionStarted.type !== "session_started") {
      throw new Error("Cannot send audio before the session starts");
    }
    this.send({
      type: "audio_chunk",
      sessionId: sessionStarted.sessionId,
      sequence,
      timestampMs,
      encoding: "pcm_s16le",
      dataBase64: audio.toString("base64"),
    });
  }

  async waitForMessage(
    predicate: (message: ServerMessage) => boolean,
  ): Promise<ServerMessage> {
    return waitFor(() => this.messages.find(predicate));
  }

  async waitForFinalCount(count: number): Promise<Array<
    Extract<ServerMessage, { type: "caption" }>
  >> {
    return waitFor(() => {
      const finals = this.messages.filter(
        (message): message is Extract<ServerMessage, { type: "caption" }> => (
          message.type === "caption" && message.isFinal
        ),
      );
      return finals.length >= count ? finals : undefined;
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", resolve);
      this.socket.close();
    });
  }
}

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs = 3_000,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = read();
    if (result !== undefined) return result;
    await delay(5);
  }
  throw new Error("Timed out waiting for gateway test state");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
