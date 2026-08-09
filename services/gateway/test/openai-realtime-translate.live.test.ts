import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderStreamEvent } from "../src/speech/contract.js";
import { OpenAIRealtimeTranslateSession } from "../src/speech/openai/realtime.js";

const apiKey = process.env.OPENAI_API_KEY;
const enabled = process.env.OPENAI_REALTIME_SMOKE === "1" && Boolean(apiKey);

test(
  "opens and closes a live OpenAI translation session",
  { skip: enabled ? undefined : "set OPENAI_REALTIME_SMOKE=1 and OPENAI_API_KEY" },
  async () => {
    const events: ProviderStreamEvent[] = [];
    const session = new OpenAIRealtimeTranslateSession(
      apiKey!,
      {
        sessionId: `openai-smoke-${Date.now()}`,
        source: "es",
        target: "en",
        sampleRate: 16_000,
        channels: 1,
        onEvent: (event) => events.push(event),
      },
      { connectTimeoutMs: 10_000, flushTimeoutMs: 10_000 },
    );

    await session.open();
    await session.close();

    assert.equal(events.some((event) => (
      event.type === "state" && event.state === "open"
    )), true);
    assert.equal(events.some((event) => (
      event.type === "state" && event.state === "closed"
    )), true);
  },
);
