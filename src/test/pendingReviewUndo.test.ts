import * as assert from "node:assert/strict";
import { test } from "node:test";
import { interceptPendingReviewUndo } from "../pendingReviewUndo";
import type { ReviewFile } from "../reviewStore";

function review(status: ReviewFile["status"]): ReviewFile {
  return { status, key: "file" } as ReviewFile;
}

test("Ctrl+Z consumes a pending review and records its successful undo", async () => {
  const file = review("pending");
  let applied: ReviewFile | undefined;
  let recorded: ReviewFile[] | undefined;
  const consumed = await interceptPendingReviewUndo(file, {
    snapshots: (value) => [value],
    apply: async (value) => { applied = value; return true; },
    record: (snapshots) => { recorded = snapshots; },
  });

  assert.equal(consumed, true);
  assert.equal(applied, file);
  assert.deepEqual(recorded, [file]);
});

test("a failed pending undo is still consumed so normal editor undo cannot distort the review", async () => {
  let recorded = false;
  const consumed = await interceptPendingReviewUndo(review("pending"), {
    snapshots: (file) => [file],
    apply: async () => false,
    record: () => { recorded = true; },
  });

  assert.equal(consumed, true);
  assert.equal(recorded, false);
});

test("Ctrl+Z is not intercepted when there is no pending review", async () => {
  let applied = false;
  const consumed = await interceptPendingReviewUndo(review("kept"), {
    snapshots: (file) => [file],
    apply: async () => { applied = true; return true; },
    record: () => undefined,
  });

  assert.equal(consumed, false);
  assert.equal(applied, false);
});
