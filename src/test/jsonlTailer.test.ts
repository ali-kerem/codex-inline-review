import * as assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, truncate, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { JsonlTailer } from "../jsonlTailer";

test("retains partial JSONL lines until newline completion", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-review-tailer-"));
  const file = path.join(directory, "rollout.jsonl");
  await writeFile(file, "{\"a\":1}\n{\"b\"", "utf8");
  const tailer = new JsonlTailer();
  const first = await tailer.read(file, await tailer.initialize(file, false));
  assert.deepEqual(first.lines.map((line) => line.text), ["{\"a\":1}"]);
  await appendFile(file, ":2}\n", "utf8");
  const second = await tailer.read(file, first.checkpoint);
  assert.deepEqual(second.lines.map((line) => line.text), ["{\"b\":2}"]);
  assert.ok(second.lines[0]!.offset > first.lines[0]!.offset);
});

test("detects replacement and reads the new identity from offset zero", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-review-rotation-"));
  const file = path.join(directory, "rollout.jsonl");
  await writeFile(file, "old\n", "utf8");
  const tailer = new JsonlTailer();
  const old = await tailer.read(file, await tailer.initialize(file, false));
  await rename(file, path.join(directory, "rollout.old.jsonl"));
  await writeFile(file, "new\n", "utf8");
  const rotated = await tailer.read(file, old.checkpoint);
  assert.equal(rotated.replaced, true);
  assert.deepEqual(rotated.lines.map((line) => line.text), ["new"]);
});

test("detects truncation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-review-truncate-"));
  const file = path.join(directory, "rollout.jsonl");
  await writeFile(file, "first\nsecond\n", "utf8");
  const tailer = new JsonlTailer();
  const initial = await tailer.read(file, await tailer.initialize(file, false));
  await truncate(file, 0);
  await appendFile(file, "x\n", "utf8");
  const result = await tailer.read(file, initial.checkpoint);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.lines.map((line) => line.text), ["x"]);
});
