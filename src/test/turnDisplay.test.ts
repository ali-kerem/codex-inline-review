import * as assert from "node:assert/strict";
import { test } from "node:test";
import { formatTurnTimestamp, turnDisplayLabel } from "../turnDisplay";

test("formats turn labels with a 24-hour local timestamp", () => {
  const timestamp = "2026-08-02T14:05:00";
  assert.equal(formatTurnTimestamp(timestamp), "14:05 02.08.2026");
  assert.equal(turnDisplayLabel("019fc217abcdef", timestamp), "Turn 019fc217 14:05 02.08.2026");
});

test("retains an invalid timestamp instead of inventing a date", () => {
  assert.equal(formatTurnTimestamp("unknown"), "unknown");
});
