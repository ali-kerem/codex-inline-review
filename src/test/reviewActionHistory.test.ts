import * as assert from "node:assert/strict";
import { test } from "node:test";
import type * as vscode from "vscode";
import { actionMatchesSide, ReviewActionHistory } from "../reviewActionHistory";
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
  public readonly values = new Map<string, string | null>();
  public async readText(target: vscode.Uri): Promise<string | null> {
    return this.values.get(target.toString()) ?? null;
  }
  public set(target: vscode.Uri, value: string | null): void {
    this.values.set(target.toString(), value);
  }
}

function updateReview(target: vscode.Uri): ReviewFile {
  return {
    key: target.toString(),
    uri: target,
    kind: "update",
    status: "pending",
    turnIds: ["turn"],
    timestamp: "2026-08-02T00:00:00Z",
    originalContent: "original\n",
    postContent: "agent\n",
    originalHash: hashText("original\n"),
    postHash: hashText("agent\n"),
    markers: { addedLines: [0], deletions: [{ line: 0, removedText: "original" }], firstChangedLine: 0 },
  };
}

test("Keep action can be undone and redone as review state without changing text", async () => {
  const target = uri("/workspace/file.txt");
  const access = new MemoryAccess();
  access.set(target, "agent\n");
  const history = new ReviewActionHistory();
  const action = history.record("keep", [updateReview(target)])!;
  assert.equal(await actionMatchesSide(action, "post", access), true);
  assert.equal(history.undoFor(target)?.id, action.id);
  history.commitUndo(action);
  assert.equal(history.redoFor(target)?.id, action.id);
  history.commitRedo(action);
  assert.equal(history.undoFor(target)?.id, action.id);
});

test("Undo action requires original state before Ctrl+Z and post state afterward", async () => {
  const target = uri("/workspace/file.txt");
  const access = new MemoryAccess();
  const history = new ReviewActionHistory();
  const action = history.record("undo", [updateReview(target)])!;
  access.set(target, "original\n");
  assert.equal(await actionMatchesSide(action, "original", access), true);
  assert.equal(await actionMatchesSide(action, "post", access), false);
  access.set(target, "agent\n");
  assert.equal(await actionMatchesSide(action, "post", access), true);
});

test("new Codex changes invalidate old review actions for the same URI", () => {
  const first = uri("/workspace/first.txt");
  const second = uri("/workspace/second.txt");
  const history = new ReviewActionHistory();
  history.record("keep", [updateReview(first)]);
  history.record("keep", [updateReview(second)]);
  history.invalidateUris([first]);
  assert.equal(history.undoFor(first), undefined);
  assert.notEqual(history.undoFor(second), undefined);
});

test("state matching covers added, deleted, and moved files", async () => {
  const access = new MemoryAccess();
  const added = uri("/workspace/added.txt");
  const deleted = uri("/workspace/deleted.txt");
  const source = uri("/workspace/source.txt");
  const destination = uri("/workspace/destination.txt");
  const base = {
    status: "pending" as const,
    turnIds: ["turn"],
    timestamp: "2026-08-02T00:00:00Z",
    markers: { addedLines: [], deletions: [], firstChangedLine: 0 },
  };
  const files: ReviewFile[] = [
    { ...base, key: added.toString(), uri: added, kind: "add", originalContent: null, postContent: "added\n", postHash: hashText("added\n") },
    { ...base, key: deleted.toString(), uri: deleted, kind: "delete", originalContent: "deleted\n", postContent: null, originalHash: hashText("deleted\n") },
    { ...base, key: source.toString(), uri: source, moveUri: destination, kind: "move", originalContent: "source\n", postContent: "destination\n", originalHash: hashText("source\n"), postHash: hashText("destination\n") },
  ];
  access.set(added, "added\n");
  access.set(deleted, null);
  access.set(source, null);
  access.set(destination, "destination\n");
  const post = new ReviewActionHistory().record("keep", files)!;
  assert.equal(await actionMatchesSide(post, "post", access), true);
  access.set(added, null);
  access.set(deleted, "deleted\n");
  access.set(source, "source\n");
  access.set(destination, null);
  assert.equal(await actionMatchesSide(post, "original", access), true);
});
