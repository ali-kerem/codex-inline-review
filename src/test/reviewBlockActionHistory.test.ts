import * as assert from "node:assert/strict";
import { test } from "node:test";
import type * as vscode from "vscode";
import { blockActionMatchesState, ReviewBlockActionHistory } from "../reviewBlockActionHistory";
import type { ReviewFile, ReviewFileAccess } from "../reviewStore";
import { hashText } from "../hash";

class FakeUri {
  public constructor(public readonly fsPath: string) {}
  public toString(): string { return `file://${this.fsPath}`; }
}

function uri(value: string): vscode.Uri {
  return new FakeUri(value) as unknown as vscode.Uri;
}

class MemoryAccess implements ReviewFileAccess {
  public value: string | null = null;
  public async readText(): Promise<string | null> { return this.value; }
}

function review(target: vscode.Uri, originalContent: string, postContent: string, status: ReviewFile["status"] = "pending"): ReviewFile {
  return {
    key: target.toString(),
    uri: target,
    kind: "update",
    status,
    turnIds: ["turn"],
    timestamp: "2026-08-02T00:00:00Z",
    originalContent,
    postContent,
    originalHash: hashText(originalContent),
    postHash: hashText(postContent),
    markers: { addedLines: [0], deletions: [{ line: 0, removedText: originalContent }], firstChangedLine: 0 },
  };
}

test("partial block actions undo and redo in order", () => {
  const target = uri("/workspace/file.txt");
  const history = new ReviewBlockActionHistory();
  const first = history.record("keep", review(target, "old a\nold b\n", "new a\nnew b\n"), review(target, "new a\nold b\n", "new a\nnew b\n"), "new a\nnew b\n", "new a\nnew b\n");
  const second = history.record("undo", review(target, "new a\nold b\n", "new a\nnew b\n"), review(target, "new a\nold b\n", "new a\nold b\n", "undone"), "new a\nnew b\n", "new a\nold b\n");

  assert.equal(history.undoFor(target)?.id, second.id);
  history.commitUndo(second);
  assert.equal(history.undoFor(target)?.id, first.id);
  history.commitUndo(first);
  assert.equal(history.redoFor(target)?.id, first.id);
});

test("block action matching requires both review state and live file text", async () => {
  const target = uri("/workspace/file.txt");
  const before = review(target, "old\n", "new\n");
  const after = review(target, "new\n", "new\n", "kept");
  const action = new ReviewBlockActionHistory().record("keep", before, after, "new\n", "new\n");
  const access = new MemoryAccess();
  access.value = "new\n";
  assert.equal(await blockActionMatchesState(action, "after", after, access), true);
  access.value = "manual edit\n";
  assert.equal(await blockActionMatchesState(action, "after", after, access), false);
  assert.equal(await blockActionMatchesState(action, "after", before, access), false);
});
