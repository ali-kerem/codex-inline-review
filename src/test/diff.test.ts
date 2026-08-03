import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  computeReviewBlocks,
  computeReviewMarkers,
  contentToUnifiedDiff,
  materializePostFromMixedContent,
  parseUnifiedDiff,
  resolveReviewBlock,
  reverseApplyUnifiedDiff,
  reviewBlockStarts,
} from "../diff";

test("reverses one hunk exactly", () => {
  const post = "one\ninserted\ntwo\n";
  const diff = "@@ -1,2 +1,3 @@\n one\n+inserted\n two\n";
  assert.equal(reverseApplyUnifiedDiff(post, diff).original, "one\ntwo\n");
});

test("reverses multiple hunks and paths with spaces in headers", () => {
  const post = "alpha\ninserted one\nbeta\ngamma\ndelta\ninserted two\nepsilon\n";
  const diff = "--- a/analyze logs.py\n+++ b/analyze logs.py\n@@ -1,2 +1,3 @@\n alpha\n+inserted one\n beta\n@@ -4,2 +5,3 @@\n delta\n+inserted two\n epsilon\n";
  assert.equal(parseUnifiedDiff(diff).hunks.length, 2);
  assert.equal(reverseApplyUnifiedDiff(post, diff).original, "alpha\nbeta\ngamma\ndelta\nepsilon\n");
});

test("preserves missing final newline", () => {
  const post = "one\ntwo\n";
  const diff = "@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+two\n";
  assert.equal(reverseApplyUnifiedDiff(post, diff).original, "one\ntwo");
});

test("supports CRLF", () => {
  const post = "one\r\ninserted\r\ntwo\r\n";
  const diff = "@@ -1,2 +1,3 @@\r\n one\r\n+inserted\r\n two\r\n";
  assert.equal(reverseApplyUnifiedDiff(post, diff).original, "one\r\ntwo\r\n");
  const deleted = contentToUnifiedDiff("one\r\ntwo\r\n", "delete");
  assert.equal(reverseApplyUnifiedDiff("", deleted).original, "one\r\ntwo\r\n");
});

test("handles empty additions and deletions", () => {
  assert.equal(reverseApplyUnifiedDiff("", contentToUnifiedDiff("", "delete")).original, "");
  assert.equal(contentToUnifiedDiff("", "add"), "@@ -0,0 +0,0 @@\n");
});

test("rejects a non-exact post image", () => {
  assert.throws(() => reverseApplyUnifiedDiff("wrong\n", "@@ -1 +1 @@\n-old\n+new\n"), /does not match/u);
});

test("materializes the complete post side from partially accepted content", () => {
  const diff = "@@ -1,5 +1,5 @@\n-old first\n+new first\n context\n-removed\n+replacement\n tail\n-old last\n+new last\n";
  const mixed = "new first\ncontext\nremoved\ntail\nold last\n";
  const post = "new first\ncontext\nreplacement\ntail\nnew last\n";
  assert.equal(materializePostFromMixedContent(mixed, diff), post);
  assert.equal(reverseApplyUnifiedDiff(post, diff).original, "old first\ncontext\nremoved\ntail\nold last\n");
});

test("materializes discarded insertions and deletions", () => {
  const insertion = "@@ -1,2 +1,3 @@\n one\n+inserted\n two\n";
  assert.equal(materializePostFromMixedContent("one\ntwo\n", insertion), "one\ninserted\ntwo\n");

  const deletion = "@@ -1,3 +1,2 @@\n one\n-removed\n two\n";
  assert.equal(materializePostFromMixedContent("one\nremoved\ntwo\n", deletion), "one\ntwo\n");
});

test("computes green lines and exact deleted blocks", () => {
  const markers = computeReviewMarkers("one\ntwo\nthree\n", "one\nchanged\nthree\nfour\n");
  assert.deepEqual(markers.addedLines, [1, 3]);
  assert.equal(markers.deletions[0]?.removedText, "two");
  assert.equal(markers.firstChangedLine, 1);
});

test("finds one control anchor per contiguous change block", () => {
  assert.deepEqual(reviewBlockStarts({
    addedLines: [2, 3, 8, 12],
    deletions: [
      { line: 2, removedText: "replaced" },
      { line: 6, removedText: "deleted" },
      { line: 8, removedText: "also replaced" },
      { line: 11, removedText: "separate deletion" },
    ],
    firstChangedLine: 2,
  }), [2, 6, 8, 11, 12]);
});

test("computes and independently resolves review blocks", () => {
  const original = "one\nold first\ncontext\nold second\nend\n";
  const post = "one\nnew first\ncontext\nnew second\nextra\nend\n";
  const blocks = computeReviewBlocks(original, post);
  assert.equal(blocks.length, 2);

  const kept = resolveReviewBlock(original, post, blocks[0]?.id ?? "", "keep");
  assert.equal(kept?.originalContent, "one\nnew first\ncontext\nold second\nend\n");
  assert.equal(kept?.postContent, post);
  assert.equal(computeReviewBlocks(kept?.originalContent ?? "", kept?.postContent ?? "").length, 1);

  const undone = resolveReviewBlock(original, post, blocks[1]?.id ?? "", "undo");
  assert.equal(undone?.originalContent, original);
  assert.equal(undone?.postContent, "one\nnew first\ncontext\nold second\nend\n");
  assert.equal(computeReviewBlocks(undone?.originalContent ?? "", undone?.postContent ?? "").length, 1);
});

test("block resolution preserves final-newline changes", () => {
  const block = computeReviewBlocks("value", "changed\n")[0];
  assert.ok(block);
  assert.equal(resolveReviewBlock("value", "changed\n", block.id, "undo")?.postContent, "value");
  assert.equal(resolveReviewBlock("value", "changed\n", block.id, "keep")?.originalContent, "changed\n");
});

test("before/after fixtures reverse deterministically", async () => {
  const before = await readFile("src/test/fixtures/inventory.before.txt", "utf8");
  const after = await readFile("src/test/fixtures/inventory.after.txt", "utf8");
  const diff = "@@ -5,2 +5,5 @@\n     def add_item(self, name: str, quantity: int) -> None:\n+        if quantity <= 0:\n+            raise ValueError(\"quantity must be positive\")\n+\n         current_quantity = self.items.get(name, 0)\n";
  assert.equal(reverseApplyUnifiedDiff(after, diff).original, before);
});
