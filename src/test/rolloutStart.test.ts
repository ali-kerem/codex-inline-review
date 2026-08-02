import * as assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { batchPassesForkBoundary, inspectRolloutStart, rolloutLogicalEventIds } from "../rolloutStart";

test("detects a persisted fork marker without reading event contents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-review-fork-"));
  const file = path.join(directory, "fork.jsonl");
  await writeFile(file, `${JSON.stringify({
    timestamp: "2026-08-02T10:00:00.000Z",
    type: "session_meta",
    payload: { forked_from_id: "parent-thread", timestamp: "2026-08-02T09:59:59.900Z" },
  })}\n{\"type\":\"event_msg\"}\n`, "utf8");
  const inspection = await inspectRolloutStart(file);
  assert.equal(inspection.complete, true);
  assert.equal(inspection.forkTimestampMs, Date.parse("2026-08-02T10:00:00.000Z"));
  assert.equal(inspection.forkedFromId, "parent-thread");
});

test("distinguishes normal and partial rollout starts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-review-start-"));
  const normal = path.join(directory, "normal.jsonl");
  const partial = path.join(directory, "partial.jsonl");
  await writeFile(normal, `${JSON.stringify({ timestamp: "2026-08-02T10:00:00Z", type: "session_meta", payload: { id: "thread" } })}\n`, "utf8");
  await writeFile(partial, "{\"type\":\"session_meta\"", "utf8");
  assert.deepEqual(await inspectRolloutStart(normal), { complete: true });
  assert.deepEqual(await inspectRolloutStart(partial), { complete: false });
});

test("fork boundary exactly suppresses parent logical events even when copy timestamps are rewritten", () => {
  const forkTimestamp = Date.parse("2026-08-02T10:00:00Z");
  const parentIds = new Set(["copied-call:copied-turn"]);
  assert.equal(batchPassesForkBoundary("2026-08-02T10:00:00.003Z", "copied-call:copied-turn", forkTimestamp, parentIds), false);
  assert.equal(batchPassesForkBoundary("2026-08-02T10:00:00.003Z", "new-call:new-turn", forkTimestamp, parentIds), true);
  assert.equal(batchPassesForkBoundary("2026-08-02T10:00:00.500Z", "unknown", forkTimestamp), false);
  assert.equal(batchPassesForkBoundary("2026-08-02T10:00:01.001Z", "new", forkTimestamp), true);
  assert.equal(batchPassesForkBoundary("invalid", "new", forkTimestamp), false);
  assert.equal(batchPassesForkBoundary("2020-01-01T00:00:00Z", "anything", undefined), true);
});

test("indexes only logical patch identities from a parent rollout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-review-parent-"));
  const file = path.join(directory, "parent.jsonl");
  await writeFile(file, [
    JSON.stringify({ type: "response_item", payload: { type: "message", content: "not inspected" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "patch_apply_end", call_id: "call", turn_id: "turn" } }),
    "invalid",
    "",
  ].join("\n"), "utf8");
  assert.deepEqual([...await rolloutLogicalEventIds(file)], ["call:turn"]);
});
