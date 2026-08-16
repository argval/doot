import assert from "node:assert/strict";
import test from "node:test";
import { mergeStreamingText } from "../src/merge-text.js";

test("replaces a corrected cumulative snapshot instead of repeating it", () => {
  assert.equal(
    mergeStreamingText(
      "Where is the train station?",
      "Where is the railway station?",
    ),
    "Where is the railway station?",
  );
});

test("appends a distinct streaming fragment", () => {
  assert.equal(
    mergeStreamingText("Where is this?", "It is nearby."),
    "Where is this? It is nearby.",
  );
});
