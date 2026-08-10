import assert from "node:assert/strict";
import test from "node:test";
import { optionalEnvironmentValue } from "../src/config.js";

test("normalizes blank optional environment values to undefined", () => {
  assert.equal(optionalEnvironmentValue(undefined), undefined);
  assert.equal(optionalEnvironmentValue(""), undefined);
  assert.equal(optionalEnvironmentValue("  \t \n "), undefined);
});

test("preserves configured environment values without surrounding whitespace", () => {
  assert.equal(optionalEnvironmentValue("  sarvam-key  "), "sarvam-key");
});
