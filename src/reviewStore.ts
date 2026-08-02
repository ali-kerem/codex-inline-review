import type * as vscode from "vscode";
import {
  computeReviewBlocks,
  computeReviewMarkers,
  resolveReviewBlock,
  reverseApplyUnifiedDiff,
  reviewMarkersFromUnifiedDiff,
  type ReviewMarkers,
} from "./diff";
import { hashText } from "./hash";
import type { ChangeBatch, ChangeKind, FileChange } from "./model";

export type ReviewStatus = "pending" | "kept" | "undone" | "reconstructionFailed" | "conflicted";
export type ReviewCategory = "pending" | "accepted" | "partiallyAccepted" | "discarded";

export interface ReviewFile {
  key: string;
  uri: vscode.Uri;
  moveUri?: vscode.Uri;
  kind: ChangeKind;
  status: ReviewStatus;
  message?: string;
  turnIds: string[];
  timestamp: string;
  originalContent: string | null;
  postContent: string | null;
  /** Immutable pre-Codex side used by the full and accepted-only diffs. */
  fullOriginalContent?: string | null;
  /** Immutable complete Codex proposal used by the full diff. */
  fullPostContent?: string | null;
  originalHash?: string;
  postHash?: string;
  markers: ReviewMarkers;
}

export interface ReviewTurn {
  turnId: string;
  timestamp: string;
  fileKeys: string[];
}

export interface ReviewFileAccess {
  readText(uri: vscode.Uri): Promise<string | null>;
}

type Listener = () => void;

export function isActiveStatus(status: ReviewStatus): boolean {
  return status === "pending" || status === "reconstructionFailed" || status === "conflicted";
}

export function cloneReviewFile(file: ReviewFile): ReviewFile {
  return {
    ...file,
    turnIds: [...file.turnIds],
    markers: {
      addedLines: [...file.markers.addedLines],
      deletions: file.markers.deletions.map((deletion) => ({ ...deletion })),
      firstChangedLine: file.markers.firstChangedLine,
    },
  };
}

function stateMatches(previousPost: string | null, nextOriginal: string | null): boolean {
  if (previousPost === null || nextOriginal === null) {
    return previousPost === nextOriginal;
  }
  return hashText(previousPost) === hashText(nextOriginal);
}

export function fullOriginalContent(file: ReviewFile): string | null {
  return file.fullOriginalContent === undefined ? file.originalContent : file.fullOriginalContent;
}

export function fullPostContent(file: ReviewFile): string | null {
  return file.fullPostContent === undefined ? file.postContent : file.fullPostContent;
}

export function hasPendingReviewBlocks(file: ReviewFile): boolean {
  return file.status === "pending"
    && computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "").length > 0;
}

export function hasAcceptedChanges(file: ReviewFile): boolean {
  return !stateMatches(fullOriginalContent(file), file.originalContent);
}

export function reviewCategory(file: ReviewFile): ReviewCategory {
  if (file.status === "reconstructionFailed" || file.status === "conflicted") {
    return "pending";
  }
  const hasAccepted = hasAcceptedChanges(file);
  const hasDiscarded = !stateMatches(fullPostContent(file), file.postContent);
  const hasPending = hasPendingReviewBlocks(file);
  if (hasPending) {
    return "pending";
  }
  if (hasAccepted && (hasDiscarded || file.status === "undone")) {
    return "partiallyAccepted";
  }
  if (hasAccepted) {
    return "accepted";
  }
  if (file.status === "kept") {
    return "accepted";
  }
  if (file.status === "undone" || hasDiscarded) {
    return "discarded";
  }
  return "pending";
}

function composedKind(original: string | null, post: string | null, moveUri?: vscode.Uri): ChangeKind {
  if (moveUri) {
    return "move";
  }
  if (original === null) {
    return "add";
  }
  if (post === null) {
    return "delete";
  }
  return "update";
}

export class ReviewStore {
  private readonly files = new Map<string, ReviewFile>();
  private readonly turns = new Map<string, ReviewTurn>();
  private readonly listeners = new Set<Listener>();
  private interactiveTurnId: string | undefined;

  public constructor(private readonly access: ReviewFileAccess) {}

  public subscribe(listener: Listener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public allFiles(): ReviewFile[] {
    return [...this.files.values()];
  }

  public allTurns(): ReviewTurn[] {
    return [...this.turns.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  public activeFiles(): ReviewFile[] {
    const turnId = this.interactiveTurnId;
    return turnId
      ? this.allFiles().filter((file) => file.turnIds.includes(turnId) && isActiveStatus(file.status))
      : [];
  }

  public currentTurnId(): string | undefined {
    return this.interactiveTurnId;
  }

  public isArchivedTurn(turnId: string): boolean {
    return this.interactiveTurnId !== undefined && turnId !== this.interactiveTurnId;
  }

  public willActivateTurn(turnId: string, timestamp: string): boolean {
    if (!this.interactiveTurnId) {
      return true;
    }
    if (turnId === this.interactiveTurnId || this.turns.has(turnId)) {
      return false;
    }
    const activeTimestamp = this.turns.get(this.interactiveTurnId)?.timestamp ?? "";
    return timestamp >= activeTimestamp;
  }

  public get(key: string): ReviewFile | undefined {
    return this.files.get(key);
  }

  public snapshots(keys: string[]): ReviewFile[] {
    return keys.flatMap((key) => {
      const file = this.files.get(key);
      return file ? [cloneReviewFile(file)] : [];
    });
  }

  public findByUri(uri: vscode.Uri): ReviewFile | undefined {
    const value = uri.toString();
    return this.activeFiles().find((file) => file.uri.toString() === value || file.moveUri?.toString() === value);
  }

  public async ingest(batch: ChangeBatch): Promise<void> {
    if (this.willActivateTurn(batch.turnId, batch.timestamp)) {
      if (this.interactiveTurnId && this.interactiveTurnId !== batch.turnId) {
        this.finalizeTurn(this.interactiveTurnId);
      }
      this.interactiveTurnId = batch.turnId;
    }
    const archivedIncomingTurn = this.interactiveTurnId !== batch.turnId;
    const turn = this.turns.get(batch.turnId) ?? { turnId: batch.turnId, timestamp: batch.timestamp, fileKeys: [] };
    for (const change of batch.changes) {
      const next = await this.reconstruct(change, batch.turnId, batch.timestamp);
      const existing = this.files.get(next.key);
      let stored = next;
      if (existing) {
        if (archivedIncomingTurn) {
          if (next.status === "pending" && stateMatches(fullPostContent(existing), next.originalContent)) {
            existing.postContent = next.postContent;
            existing.postHash = next.postHash;
            existing.fullPostContent = fullPostContent(next);
            existing.moveUri = next.moveUri;
            existing.kind = composedKind(fullOriginalContent(existing), next.postContent, next.moveUri);
            existing.timestamp = batch.timestamp;
            this.markKept(existing);
          }
          stored = existing;
        } else if (existing.status === "kept" && next.status === "pending" && stateMatches(existing.postContent, next.originalContent)) {
          existing.originalContent = next.originalContent;
          existing.postContent = next.postContent;
          existing.originalHash = next.originalHash;
          existing.postHash = next.postHash;
          existing.fullPostContent = fullPostContent(next);
          existing.moveUri = next.moveUri;
          existing.kind = composedKind(existing.originalContent, next.postContent, next.moveUri);
          existing.markers = computeReviewMarkers(existing.originalContent ?? "", next.postContent ?? "");
          existing.status = "pending";
          existing.message = undefined;
          existing.timestamp = batch.timestamp;
          stored = existing;
        } else if (existing.status !== "pending" || next.status !== "pending" || !stateMatches(existing.postContent, next.originalContent)) {
          existing.status = "conflicted";
          existing.message = "A later Codex change could not be composed with the pending snapshot exactly.";
          existing.markers = { addedLines: [], deletions: [], firstChangedLine: 0 };
          if (!existing.turnIds.includes(batch.turnId)) {
            existing.turnIds.push(batch.turnId);
          }
          stored = existing;
        } else {
          const moveUri = next.kind === "move" ? next.moveUri : existing.moveUri;
          existing.postContent = next.postContent;
          existing.postHash = next.postHash;
          existing.fullPostContent = fullPostContent(next);
          existing.moveUri = moveUri;
          existing.kind = composedKind(existing.originalContent, next.postContent, moveUri);
          existing.markers = computeReviewMarkers(existing.originalContent ?? "", next.postContent ?? "");
          existing.timestamp = batch.timestamp;
          if (!existing.turnIds.includes(batch.turnId)) {
            existing.turnIds.push(batch.turnId);
          }
          stored = existing;
        }
      } else {
        if (archivedIncomingTurn && next.status === "pending") {
          this.markKept(next);
        }
        this.files.set(next.key, next);
      }
      if (!turn.fileKeys.includes(stored.key)) {
        turn.fileKeys.push(stored.key);
      }
    }
    this.turns.set(batch.turnId, turn);
    this.emit();
  }

  public keep(key: string): boolean {
    const file = this.files.get(key);
    if (!file || !isActiveStatus(file.status)) {
      return false;
    }
    this.markKept(file);
    this.emit();
    return true;
  }

  public keepFiles(keys: string[]): number {
    let count = 0;
    for (const key of keys) {
      const file = this.files.get(key);
      if (!file || !isActiveStatus(file.status)) {
        continue;
      }
      this.markKept(file);
      count += 1;
    }
    if (count > 0) {
      this.emit();
    }
    return count;
  }

  public keepBlock(key: string, blockId: string): boolean {
    return this.resolveBlock(key, blockId, "keep");
  }

  public resolveUndoneBlock(key: string, blockId: string): boolean {
    return this.resolveBlock(key, blockId, "undo");
  }

  public keepAll(): number {
    return this.keepFiles(this.activeFiles().map((file) => file.key));
  }

  public markUndone(keys: string[]): void {
    this.setStatuses(keys, "undone");
  }

  public setStatuses(keys: string[], status: ReviewStatus): void {
    let changed = false;
    for (const key of keys) {
      const file = this.files.get(key);
      if (file) {
        file.status = status;
        file.message = undefined;
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  public restoreSnapshots(snapshots: ReviewFile[]): void {
    for (const snapshot of snapshots) {
      this.files.set(snapshot.key, cloneReviewFile(snapshot));
    }
    if (snapshots.length > 0) {
      this.emit();
    }
  }

  public markConflicted(key: string, message: string): void {
    const file = this.files.get(key);
    if (file) {
      file.status = "conflicted";
      file.message = message;
      file.markers = { addedLines: [], deletions: [], firstChangedLine: 0 };
      this.emit();
    }
  }

  public clear(): void {
    this.files.clear();
    this.turns.clear();
    this.interactiveTurnId = undefined;
    this.emit();
  }

  private async reconstruct(change: FileChange, turnId: string, timestamp: string): Promise<ReviewFile> {
    const key = JSON.stringify([turnId, change.uri.toString()]);
    let current: string | null = null;
    try {
      if (change.kind === "move") {
        if (!change.moveUri) {
          throw new Error("Move event has no destination path.");
        }
        const sourceCurrent = await this.access.readText(change.uri);
        if (sourceCurrent !== null) {
          throw new Error("Move source still exists; refusing to infer the move state.");
        }
        current = await this.access.readText(change.moveUri);
        if (current === null) {
          throw new Error("Move destination does not exist.");
        }
      } else if (change.kind === "delete") {
        current = await this.access.readText(change.uri);
        if (current !== null) {
          throw new Error("Deleted path currently exists.");
        }
      } else {
        current = await this.access.readText(change.uri);
        if (current === null) {
          throw new Error("Post-edit file does not exist.");
        }
      }

      let original: string | null;
      let post: string | null;
      if (change.kind === "add") {
        original = null;
        post = current;
      } else if (change.kind === "delete") {
        original = reverseApplyUnifiedDiff("", change.unifiedDiff).original;
        post = null;
      } else {
        original = reverseApplyUnifiedDiff(current ?? "", change.unifiedDiff).original;
        post = current;
      }
      return {
        key,
        uri: change.uri,
        ...(change.moveUri ? { moveUri: change.moveUri } : {}),
        kind: change.kind,
        status: "pending",
        turnIds: [turnId],
        timestamp,
        originalContent: original,
        postContent: post,
        fullOriginalContent: original,
        fullPostContent: post,
        ...(original !== null ? { originalHash: hashText(original) } : {}),
        ...(post !== null ? { postHash: hashText(post) } : {}),
        markers: reviewMarkersFromUnifiedDiff(change.unifiedDiff),
      };
    } catch (error) {
      let markers: ReviewMarkers = { addedLines: [], deletions: [], firstChangedLine: 0 };
      try {
        markers = reviewMarkersFromUnifiedDiff(change.unifiedDiff);
      } catch {
        // The status and message explain why this review cannot be reconstructed.
      }
      return {
        key,
        uri: change.uri,
        ...(change.moveUri ? { moveUri: change.moveUri } : {}),
        kind: change.kind,
        status: "reconstructionFailed",
        message: error instanceof Error ? error.message : String(error),
        turnIds: [turnId],
        timestamp,
        originalContent: null,
        postContent: current,
        fullOriginalContent: null,
        fullPostContent: current,
        ...(current !== null ? { postHash: hashText(current) } : {}),
        markers,
      };
    }
  }

  private resolveBlock(key: string, blockId: string, resolution: "keep" | "undo"): boolean {
    const file = this.files.get(key);
    if (!file || file.status !== "pending" || file.kind === "move") {
      return false;
    }
    const resolved = resolveReviewBlock(file.originalContent ?? "", file.postContent ?? "", blockId, resolution);
    if (!resolved) {
      return false;
    }
    if (resolution === "keep") {
      file.originalContent = resolved.originalContent;
    } else {
      file.postContent = resolved.postContent;
    }
    file.kind = composedKind(file.originalContent, file.postContent, file.moveUri);
    if (file.originalContent === null) {
      delete file.originalHash;
    } else {
      file.originalHash = hashText(file.originalContent);
    }
    if (file.postContent === null) {
      delete file.postHash;
    } else {
      file.postHash = hashText(file.postContent);
    }
    const remaining = computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "");
    file.markers = remaining.length > 0
      ? computeReviewMarkers(file.originalContent ?? "", file.postContent ?? "")
      : { addedLines: [], deletions: [], firstChangedLine: 0 };
    file.status = remaining.length > 0 ? "pending" : resolution === "keep" ? "kept" : "undone";
    file.message = undefined;
    this.emit();
    return true;
  }

  private markKept(file: ReviewFile): void {
    file.originalContent = file.postContent;
    if (file.originalContent === null) {
      delete file.originalHash;
    } else {
      file.originalHash = hashText(file.originalContent);
    }
    file.markers = { addedLines: [], deletions: [], firstChangedLine: 0 };
    file.status = "kept";
    file.message = undefined;
  }

  private finalizeTurn(turnId: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) {
      return;
    }
    for (const key of turn.fileKeys) {
      const file = this.files.get(key);
      if (file?.status === "pending") {
        this.markKept(file);
      }
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
