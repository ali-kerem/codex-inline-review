import * as assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  findRolloutBySessionId,
  normalizeSessionId,
  recentDateDirectories,
  recentRolloutFiles,
} from "../rolloutDiscovery";

test("normalizes and validates Codex session IDs", () => {
  assert.equal(normalizeSessionId(" 00000000-0000-0000-0000-000000000000 "), "00000000-0000-0000-0000-000000000000");
  assert.throws(() => normalizeSessionId("not-a-session"), /UUID/u);
});

test("builds a bounded recent date window", () => {
  const directories = recentDateDirectories("/codex", new Date("2026-08-03T12:00:00"), 3);
  assert.deepEqual(directories, [
    path.join("/codex", "sessions", "2026", "08", "03"),
    path.join("/codex", "sessions", "2026", "08", "02"),
    path.join("/codex", "sessions", "2026", "08", "01"),
  ]);
});

test("discovers recent rollouts and locates an older session by ID", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-review-discovery-"));
  const oldDirectory = path.join(codexHome, "sessions", "2026", "07", "01");
  const recentDirectory = path.join(codexHome, "sessions", "2026", "08", "02");
  await mkdir(oldDirectory, { recursive: true });
  await mkdir(recentDirectory, { recursive: true });
  const sessionId = "00000000-0000-0000-0000-000000000000";
  const oldRollout = path.join(oldDirectory, `rollout-2026-07-01T12-00-00-${sessionId}.jsonl`);
  const recentRollout = path.join(recentDirectory, "rollout-recent.jsonl");
  await writeFile(oldRollout, "", "utf8");
  await writeFile(recentRollout, "", "utf8");

  assert.deepEqual(await recentRolloutFiles(codexHome, new Date("2026-08-03T12:00:00"), 2), [recentRollout]);
  assert.equal(await findRolloutBySessionId(codexHome, sessionId), oldRollout);
  assert.equal(await findRolloutBySessionId(codexHome, "019fbf8d-f547-7300-bae6-b12e427e56d5"), undefined);
});
