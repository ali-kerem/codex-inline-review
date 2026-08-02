import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createInlineReviewModel } from "../inlineReview";

test("builds a single-column inline review with removed rows before added rows", () => {
  const model = createInlineReviewModel(
    "if quantity <= 0:\n    raise ValueError(\"quantity must be positive\")\nnext\n",
    "if quantity <= 0:\n    raise ValueError(\"quantity must be greater than zero\")\n    log()\nnext\n",
  );

  assert.deepEqual(model.lines.map((line) => line.kind), ["context", "removed", "added", "added", "context"]);
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0]?.line, 1);
  assert.match(model.content, /positive.*greater than zero/su);
});

test("marks only the changed substrings on paired modified lines", () => {
  const model = createInlineReviewModel(
    "raise ValueError(\"quantity must be positive\")\n",
    "raise ValueError(\"quantity must be greater than zero\")\n",
  );
  const removed = model.changedRanges.find((range) => range.kind === "removed");
  const added = model.changedRanges.find((range) => range.kind === "added");

  assert.equal(model.lines[removed?.line ?? -1]?.text.slice(removed?.start, removed?.end), "positive");
  assert.equal(model.lines[added?.line ?? -1]?.text.slice(added?.start, added?.end), "greater than zero");
});

test("keeps multiple separated blocks independently anchored", () => {
  const model = createInlineReviewModel("one\nold\nmiddle\nzero\n", "one\nnew\nmiddle\n99\n");
  assert.equal(model.blocks.length, 2);
  assert.notEqual(model.blocks[0]?.id, model.blocks[1]?.id);
  assert.ok((model.blocks[1]?.line ?? 0) > (model.blocks[0]?.line ?? 0));
});
