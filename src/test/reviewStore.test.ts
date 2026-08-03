import * as assert from "node:assert/strict";
import { test } from "node:test";
import type * as vscode from "vscode";
import type { ChangeBatch, FileChange } from "../model";
import { computeReviewBlocks } from "../diff";
import { hasAcceptedChanges, reviewCategory, ReviewStore, type ReviewFileAccess } from "../reviewStore";

class FakeUri {
  public readonly path: string;
  public constructor(public readonly fsPath: string) { this.path = fsPath; }
  public toString(): string { return `file://${this.fsPath}`; }
}

function uri(path: string): vscode.Uri {
  return new FakeUri(path) as unknown as vscode.Uri;
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

function batch(turnId: string, changes: FileChange[]): ChangeBatch {
  return { source: "rollout", eventId: `event-${turnId}`, logicalEventId: `logical-${turnId}`, turnId, timestamp: `2026-08-01T00:00:0${turnId.length}Z`, changes };
}

test("reconstructs update, add, delete, and move snapshots", async () => {
  const access = new MemoryAccess();
  const store = new ReviewStore(access);
  const update = uri("/workspace/update.txt");
  const added = uri("/workspace/added.txt");
  const deleted = uri("/workspace/deleted.txt");
  const moveSource = uri("/workspace/from.txt");
  const moveDestination = uri("/workspace/to.txt");
  access.set(update, "new\n");
  access.set(added, "created\n");
  access.set(deleted, null);
  access.set(moveSource, null);
  access.set(moveDestination, "moved and changed\n");

  await store.ingest(batch("turn-kinds", [
    { uri: update, kind: "update", unifiedDiff: "@@ -1 +1 @@\n-old\n+new\n" },
    { uri: added, kind: "add", unifiedDiff: "@@ -0,0 +1 @@\n+created\n" },
    { uri: deleted, kind: "delete", unifiedDiff: "@@ -1 +0,0 @@\n-removed\n" },
    { uri: moveSource, moveUri: moveDestination, kind: "move", unifiedDiff: "@@ -1 +1 @@\n-original\n+moved and changed\n" },
  ]));

  assert.equal(store.findByUri(update)?.originalContent, "old\n");
  assert.equal(store.findByUri(update)?.fullOriginalContent, "old\n");
  assert.equal(store.findByUri(update)?.fullPostContent, "new\n");
  assert.equal(store.findByUri(added)?.originalContent, null);
  assert.equal(store.findByUri(deleted)?.originalContent, "removed\n");
  assert.equal(store.findByUri(moveDestination)?.originalContent, "original\n");
  assert.equal(store.activeFiles().length, 4);
});

test("composes later changes in the same turn only when hashes line up", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/file.txt");
  const store = new ReviewStore(access);
  access.set(target, "a\nb\n");
  await store.ingest(batch("one", [{ uri: target, kind: "update", unifiedDiff: "@@ -1 +1,2 @@\n a\n+b\n" }]));
  access.set(target, "a\nb\nc\n");
  await store.ingest(batch("one", [{ uri: target, kind: "update", unifiedDiff: "@@ -1,2 +1,3 @@\n a\n b\n+c\n" }]));
  assert.equal(store.findByUri(target)?.status, "pending");
  assert.equal(store.findByUri(target)?.originalContent, "a\n");
  assert.equal(store.findByUri(target)?.postContent, "a\nb\nc\n");

  access.set(target, "x\ny\n");
  await store.ingest(batch("one", [{ uri: target, kind: "update", unifiedDiff: "@@ -1 +1,2 @@\n x\n+y\n" }]));
  assert.equal(store.findByUri(target)?.status, "conflicted");
});

test("a newer turn archives and auto-accepts the previous turn without reusing its file state", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/file.txt");
  const store = new ReviewStore(access);
  access.set(target, "turn one\n");
  await store.ingest(batch("one", [{ uri: target, kind: "update", unifiedDiff: "@@ -1 +1 @@\n-original\n+turn one\n" }]));
  const archivedKey = store.findByUri(target)!.key;

  access.set(target, "turn two\n");
  await store.ingest(batch("two", [{ uri: target, kind: "update", unifiedDiff: "@@ -1 +1 @@\n-turn one\n+turn two\n" }]));

  const archived = store.get(archivedKey)!;
  const active = store.findByUri(target)!;
  assert.notEqual(active.key, archived.key);
  assert.equal(store.currentTurnId(), "two");
  assert.equal(store.isArchivedTurn("one"), true);
  assert.equal(archived.status, "kept");
  assert.equal(reviewCategory(archived), "accepted");
  assert.equal(archived.fullOriginalContent, "original\n");
  assert.equal(archived.fullPostContent, "turn one\n");
  assert.equal(active.status, "pending");
  assert.equal(active.originalContent, "turn one\n");
  assert.equal(active.postContent, "turn two\n");
});

test("Keep and Undo state transitions clear active review state", async () => {
  const access = new MemoryAccess();
  const first = uri("/workspace/first.txt");
  const second = uri("/workspace/second.txt");
  access.set(first, "new\n");
  access.set(second, "new\n");
  const store = new ReviewStore(access);
  await store.ingest(batch("turn", [
    { uri: first, kind: "update", unifiedDiff: "@@ -1 +1 @@\n-old\n+new\n" },
    { uri: second, kind: "update", unifiedDiff: "@@ -1 +1 @@\n-old\n+new\n" },
  ]));
  const firstState = store.findByUri(first)!;
  const pendingSnapshots = store.snapshots(store.activeFiles().map((file) => file.key));
  assert.equal(store.keep(firstState.key), true);
  assert.equal(store.get(firstState.key)?.status, "kept");
  const secondState = store.findByUri(second)!;
  store.markUndone([secondState.key]);
  assert.equal(store.get(secondState.key)?.status, "undone");
  assert.equal(reviewCategory(store.get(secondState.key)!), "discarded");
  assert.equal(store.activeFiles().length, 0);

  store.restoreSnapshots(pendingSnapshots);
  assert.equal(store.findByUri(first)?.status, "pending");
  assert.equal(store.findByUri(second)?.status, "pending");
});

test("reconstruction failure remains read-only", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/file.txt");
  access.set(target, "different\n");
  const store = new ReviewStore(access);
  await store.ingest(batch("turn", [{ uri: target, kind: "update", unifiedDiff: "@@ -1 +1 @@\n-old\n+expected\n" }]));
  const state = store.findByUri(target);
  assert.equal(state?.status, "reconstructionFailed");
  assert.match(state?.message ?? "", /does not match/u);
});

test("Keep Change accepts only the selected block", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/file.txt");
  const post = "new first\ncontext\nnew second\n";
  access.set(target, post);
  const store = new ReviewStore(access);
  await store.ingest(batch("turn", [{
    uri: target,
    kind: "update",
    unifiedDiff: "@@ -1,3 +1,3 @@\n-old first\n+new first\n context\n-old second\n+new second\n",
  }]));
  const file = store.findByUri(target)!;
  const blocks = computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "");
  assert.equal(blocks.length, 2);

  assert.equal(store.keepBlock(file.key, blocks[0]?.id ?? ""), true);
  const remaining = store.findByUri(target)!;
  assert.equal(remaining.originalContent, "new first\ncontext\nold second\n");
  assert.equal(remaining.postContent, post);
  assert.equal(computeReviewBlocks(remaining.originalContent ?? "", remaining.postContent ?? "").length, 1);
  assert.equal(remaining.status, "pending");
  assert.equal(reviewCategory(remaining), "pending");
  assert.equal(hasAcceptedChanges(remaining), true);
  assert.equal(remaining.fullOriginalContent, "old first\ncontext\nold second\n");
  assert.equal(remaining.fullPostContent, post);
});

test("block decisions classify accepted, discarded, and partially accepted files", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/file.txt");
  access.set(target, "new first\ncontext\nnew second\n");
  const store = new ReviewStore(access);
  await store.ingest(batch("turn", [{
    uri: target,
    kind: "update",
    unifiedDiff: "@@ -1,3 +1,3 @@\n-old first\n+new first\n context\n-old second\n+new second\n",
  }]));

  const file = store.findByUri(target)!;
  const first = computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "")[0];
  assert.ok(first);
  assert.equal(store.keepBlock(file.key, first.id), true);
  assert.equal(reviewCategory(store.get(file.key)!), "pending");
  assert.equal(hasAcceptedChanges(store.get(file.key)!), true);

  const remaining = store.get(file.key)!;
  const last = computeReviewBlocks(remaining.originalContent ?? "", remaining.postContent ?? "")[0];
  assert.ok(last);
  assert.equal(store.resolveUndoneBlock(file.key, last.id), true);
  assert.equal(reviewCategory(store.get(file.key)!), "partiallyAccepted");
});

test("whole-file Keep records the complete proposal as accepted", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/file.txt");
  access.set(target, "new\n");
  const store = new ReviewStore(access);
  await store.ingest(batch("turn", [{ uri: target, kind: "update", unifiedDiff: "@@ -1 +1 @@\n-old\n+new\n" }]));
  const file = store.findByUri(target)!;

  assert.equal(store.keep(file.key), true);
  const accepted = store.get(file.key)!;
  assert.equal(reviewCategory(accepted), "accepted");
  assert.equal(accepted.originalContent, "new\n");
  assert.equal(accepted.fullOriginalContent, "old\n");
  assert.equal(accepted.fullPostContent, "new\n");
});

test("resolved block state clears only after the final block", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/file.txt");
  access.set(target, "new first\ncontext\nnew second\n");
  const store = new ReviewStore(access);
  await store.ingest(batch("turn", [{
    uri: target,
    kind: "update",
    unifiedDiff: "@@ -1,3 +1,3 @@\n-old first\n+new first\n context\n-old second\n+new second\n",
  }]));
  const file = store.findByUri(target)!;
  const first = computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "")[0];
  assert.ok(first);
  assert.equal(store.resolveUndoneBlock(file.key, first.id), true);
  const pending = store.findByUri(target)!;
  assert.equal(pending.postContent, "old first\ncontext\nnew second\n");
  const last = computeReviewBlocks(pending.originalContent ?? "", pending.postContent ?? "")[0];
  assert.ok(last);
  assert.equal(store.resolveUndoneBlock(pending.key, last.id), true);
  assert.equal(store.get(pending.key)?.status, "undone");
  assert.equal(store.findByUri(target), undefined);
});

test("session history loads every turn with only the latest turn pending", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/history.txt");
  access.set(target, "turn two\n");
  const store = new ReviewStore(access);
  const history = [
    { ...batch("one", [{ uri: target, kind: "update" as const, unifiedDiff: "@@ -1 +1 @@\n-original\n+turn one\n" }]), timestamp: "2026-08-01T10:00:00Z" },
    { ...batch("two", [{ uri: target, kind: "update" as const, unifiedDiff: "@@ -1 +1 @@\n-turn one\n+turn two\n" }]), timestamp: "2026-08-01T11:00:00Z" },
  ];

  await store.ingestSessionHistory(history);

  assert.equal(store.allTurns().length, 2);
  assert.equal(store.currentTurnId(), "two");
  const oldFile = store.get(JSON.stringify(["one", target.toString()]))!;
  const latestFile = store.get(JSON.stringify(["two", target.toString()]))!;
  assert.equal(reviewCategory(oldFile), "accepted");
  assert.equal(oldFile.fullOriginalContent, "original\n");
  assert.equal(oldFile.fullPostContent, "turn one\n");
  assert.equal(reviewCategory(latestFile), "pending");
  assert.equal(latestFile.originalContent, "turn one\n");
  assert.equal(latestFile.postContent, "turn two\n");
});

test("session history composes multiple patch events in one turn", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/composed-history.txt");
  access.set(target, "new first\nnew second\n");
  const history = [
    { ...batch("same", [{ uri: target, kind: "update" as const, unifiedDiff: "@@ -1,2 +1,2 @@\n-old first\n+new first\n old second\n" }]), eventId: "event-same-1" },
    { ...batch("same", [{ uri: target, kind: "update" as const, unifiedDiff: "@@ -1,2 +1,2 @@\n new first\n-old second\n+new second\n" }]), eventId: "event-same-2" },
  ];

  const store = new ReviewStore(access);
  await store.ingestSessionHistory(history);
  const file = store.findByUri(target)!;
  assert.equal(file.fullOriginalContent, "old first\nold second\n");
  assert.equal(file.fullPostContent, "new first\nnew second\n");
  assert.equal(computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "").length, 1);
});

test("session history reconstructs an added file that a later turn deleted", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/transient.txt");
  access.set(target, null);
  const history = [
    { ...batch("add", [{ uri: target, kind: "add" as const, unifiedDiff: "@@ -0,0 +1 @@\n+created\n" }]), timestamp: "2026-08-01T10:00:00Z" },
    { ...batch("delete", [{ uri: target, kind: "delete" as const, unifiedDiff: "@@ -1 +0,0 @@\n-created\n" }]), timestamp: "2026-08-01T11:00:00Z" },
  ];

  const store = new ReviewStore(access);
  await store.ingestSessionHistory(history);
  const added = store.get(JSON.stringify(["add", target.toString()]))!;
  const deleted = store.get(JSON.stringify(["delete", target.toString()]))!;
  assert.equal(added.fullOriginalContent, null);
  assert.equal(added.fullPostContent, "created\n");
  assert.equal(reviewCategory(added), "accepted");
  assert.equal(deleted.fullOriginalContent, "created\n");
  assert.equal(deleted.fullPostContent, null);
  assert.equal(reviewCategory(deleted), "pending");
});

test("session history preserves current decisions and restores content-free decision metadata", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/partial-history.txt");
  const post = "new first\ncontext\nnew second\n";
  access.set(target, post);
  const history = [{
    ...batch("latest", [{
      uri: target,
      kind: "update" as const,
      unifiedDiff: "@@ -1,3 +1,3 @@\n-old first\n+new first\n context\n-old second\n+new second\n",
    }]),
    timestamp: "2026-08-01T12:00:00Z",
  }];
  const store = new ReviewStore(access);
  await store.ingestSessionHistory(history);
  const initial = store.findByUri(target)!;
  const firstBlock = computeReviewBlocks(initial.originalContent ?? "", initial.postContent ?? "")[0]!;
  assert.equal(store.keepBlock(initial.key, firstBlock.id), true);

  await store.ingestSessionHistory(history);
  const preserved = store.findByUri(target)!;
  assert.equal(reviewCategory(preserved), "pending");
  assert.equal(hasAcceptedChanges(preserved), true);

  const decisions = store.storedReviewDecisions();
  assert.deepEqual(Object.keys(decisions), [initial.key]);
  assert.equal(JSON.stringify(decisions).includes("new first"), false);

  const restored = new ReviewStore(access);
  await restored.ingestSessionHistory(history, decisions);
  const restoredFile = restored.findByUri(target)!;
  assert.equal(reviewCategory(restoredFile), "pending");
  assert.equal(hasAcceptedChanges(restoredFile), true);
  assert.equal(computeReviewBlocks(restoredFile.originalContent ?? "", restoredFile.postContent ?? "").length, 1);
});

test("session history restores a partially accepted latest file after reload", async () => {
  const access = new MemoryAccess();
  const target = uri("/workspace/resolved-history.txt");
  access.set(target, "new first\ncontext\nnew second\n");
  const history = [{
    ...batch("latest", [{
      uri: target,
      kind: "update" as const,
      unifiedDiff: "@@ -1,3 +1,3 @@\n-old first\n+new first\n context\n-old second\n+new second\n",
    }]),
    timestamp: "2026-08-01T12:00:00Z",
  }];
  const originalStore = new ReviewStore(access);
  await originalStore.ingestSessionHistory(history);
  const file = originalStore.findByUri(target)!;
  const kept = computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "")[0]!;
  assert.equal(originalStore.keepBlock(file.key, kept.id), true);
  const remaining = originalStore.findByUri(target)!;
  const undone = computeReviewBlocks(remaining.originalContent ?? "", remaining.postContent ?? "")[0]!;
  assert.equal(originalStore.resolveUndoneBlock(remaining.key, undone.id), true);
  access.set(target, "new first\ncontext\nold second\n");

  const restoredStore = new ReviewStore(access);
  await restoredStore.ingestSessionHistory(history, originalStore.storedReviewDecisions());
  const restored = restoredStore.get(file.key)!;
  assert.equal(reviewCategory(restored), "partiallyAccepted");
  assert.equal(restoredStore.activeFiles().length, 0);
  assert.equal(restored.originalContent, "new first\ncontext\nold second\n");
  assert.equal(restored.postContent, "new first\ncontext\nold second\n");
});
