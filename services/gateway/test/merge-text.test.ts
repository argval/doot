import assert from "node:assert/strict";
import test from "node:test";
import { collapseStutter, mergeStreamingText } from "../src/merge-text.js";

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

test("collapses a trailing repeated phrase on partials", () => {
  assert.equal(
    mergeStreamingText("go to the store", "go to the store"),
    "go to the store",
  );
  assert.equal(
    collapseStutter("please sit down please sit down"),
    "please sit down",
  );
});

test("keeps two copies of a word but drops a longer stutter before translation", () => {
  assert.equal(collapseStutter("no no"), "no no");
  assert.equal(collapseStutter("go go go to the store"), "go go to the store");
});

test("collapses unspaced repeated characters so CJK finals are not echoed into MT", () => {
  assert.equal(collapseStutter("谢谢谢谢"), "谢谢");
});

test("keeps CJK sentence punctuation so Gemini soft-splits still fire", () => {
  assert.equal(
    collapseStutter("これは最初の文です。次の文です。"),
    "これは最初の文です。次の文です。",
  );
  assert.equal(
    collapseStutter("这是第一句话。这是第二句话。"),
    "这是第一句话。这是第二句话。",
  );
});
