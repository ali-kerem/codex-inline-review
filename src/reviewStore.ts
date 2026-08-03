import type * as vscode from "vscode";
import {
  computeReviewBlocks,
  computeReviewMarkers,
  joinText,
  materializePostFromMixedContent,
  resolveReviewBlock,
  reverseApplyUnifiedDiff,
  reviewMarkersFromUnifiedDiff,
  splitText,
  type ReviewBlock,
  type ReviewMarkers,
} from "./diff";
import { hashText } from "./hash";
import type { ChangeBatch, ChangeKind, FileChange } from "./model";

export type ReviewStatus = "pending" | "kept" | "undone" | "reconstructionFailed" | "conflicted";
export type ReviewCategory = "pending" | "accepted" | "partiallyAccepted" | "discarded";
export type ReviewBlockDecision = "keep" | "undo";

export interface StoredReviewDecision {
  blockDecisions: Record<string, ReviewBlockDecision>;
}

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
  /** Content-free decisions keyed by immutable blocks from the full proposal. */
  blockDecisions?: Record<string, ReviewBlockDecision>;
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
    ...(file.blockDecisions ? { blockDecisions: { ...file.blockDecisions } } : {}),
    markers: {
      addedLines: [...file.markers.addedLines],
      deletions: file.markers.deletions.map((deletion) => ({ ...deletion })),
      firstChangedLine: file.markers.firstChangedLine,
    },
  };
}

function contentMatches(left: string | null, right: string | null): boolean {
  return left === null || right === null ? left === right : hashText(left) === hashText(right);
}

function immutableBlocks(file: ReviewFile): ReviewBlock[] {
  return computeReviewBlocks(fullOriginalContent(file) ?? "", fullPostContent(file) ?? "");
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function immutableBlockId(file: ReviewFile, current: ReviewBlock): string | undefined {
  const decisions = file.blockDecisions ?? {};
  const candidates = immutableBlocks(file).filter((block) => decisions[block.id] === undefined);
  return candidates.find((block) => block.id === current.id)?.id
    ?? candidates
      .filter((block) => arraysEqual(block.originalLines, current.originalLines) && arraysEqual(block.postLines, current.postLines))
      .sort((left, right) => (
        Math.abs(left.originalStart - current.originalStart) + Math.abs(left.postStart - current.postStart)
      ) - (
        Math.abs(right.originalStart - current.originalStart) + Math.abs(right.postStart - current.postStart)
      ))[0]?.id;
}

function materializeDecisionSide(
  originalContent: string,
  postContent: string,
  blocks: ReviewBlock[],
  decisions: Record<string, ReviewBlockDecision>,
  side: "original" | "post",
): string {
  const original = splitText(originalContent);
  const post = splitText(postContent);
  const target = side === "original" ? original : post;
  const selected = blocks
    .filter((block) => decisions[block.id] === (side === "original" ? "keep" : "undo"))
    .sort((left, right) => side === "original" ? right.originalStart - left.originalStart : right.postStart - left.postStart);
  for (const block of selected) {
    const touchesBothEnds = block.originalStart + block.originalLines.length === original.lines.length
      && block.postStart + block.postLines.length === post.lines.length;
    if (side === "original") {
      target.lines.splice(block.originalStart, block.originalLines.length, ...block.postLines);
      if (touchesBothEnds) {
        target.finalNewline = post.finalNewline;
      }
    } else {
      target.lines.splice(block.postStart, block.postLines.length, ...block.originalLines);
      if (touchesBothEnds) {
        target.finalNewline = original.finalNewline;
      }
    }
  }
  return joinText(target);
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

interface HistoricalOccurrence {
  batch: ChangeBatch;
  change: FileChange;
  originalContent?: string | null;
  postContent?: string | null;
  error?: string;
}

function reviewKey(turnId: string, uri: vscode.Uri): string {
  return JSON.stringify([turnId, uri.toString()]);
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

  public storedReviewDecisions(): Record<string, StoredReviewDecision> {
    const stored: Record<string, StoredReviewDecision> = {};
    for (const file of this.files.values()) {
      if (file.blockDecisions && Object.keys(file.blockDecisions).length > 0) {
        stored[file.key] = { blockDecisions: { ...file.blockDecisions } };
      }
    }
    return stored;
  }

  public async ingestSessionHistory(
    batches: ChangeBatch[],
    storedDecisions: Record<string, StoredReviewDecision> = {},
  ): Promise<void> {
    const history = batches.filter((batch) => batch.changes.length > 0);
    if (history.length === 0) {
      this.clear();
      return;
    }

    const preserved = new Map([...this.files.values()].map((file) => [file.key, cloneReviewFile(file)] as const));
    const states = new Map<string, string | null>();
    for (const file of [...this.files.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
      const post = fullPostContent(file);
      if (file.kind === "move" && file.moveUri) {
        states.set(file.uri.toString(), null);
        states.set(file.moveUri.toString(), post);
      } else {
        states.set(file.uri.toString(), post);
      }
    }
    const readState = async (uri: vscode.Uri): Promise<string | null> => {
      const key = uri.toString();
      if (!states.has(key)) {
        states.set(key, await this.access.readText(uri));
      }
      return states.get(key) ?? null;
    };

    const occurrences: HistoricalOccurrence[] = history.flatMap((batch) => batch.changes.map((change) => ({ batch, change })));
    for (let index = occurrences.length - 1; index >= 0; index -= 1) {
      const occurrence = occurrences[index];
      if (!occurrence) {
        continue;
      }
      try {
        const change = occurrence.change;
        if (change.kind === "delete") {
          const current = await readState(change.uri);
          const original = reverseApplyUnifiedDiff("", change.unifiedDiff).original;
          if (current !== null && !contentMatches(current, original)) {
            throw new Error("The current file does not match either side of the historical deletion.");
          }
          occurrence.originalContent = original;
          occurrence.postContent = null;
          states.set(change.uri.toString(), original);
          continue;
        }
        if (change.kind === "move") {
          if (!change.moveUri) {
            throw new Error("Historical move has no destination path.");
          }
          const source = await readState(change.uri);
          const destination = await readState(change.moveUri);
          const mixed = destination ?? source;
          if (mixed === null) {
            throw new Error("Neither side of the historical move currently exists.");
          }
          const post = materializePostFromMixedContent(mixed, change.unifiedDiff);
          const original = reverseApplyUnifiedDiff(post, change.unifiedDiff).original;
          occurrence.originalContent = original;
          occurrence.postContent = post;
          states.set(change.uri.toString(), original);
          states.set(change.moveUri.toString(), null);
          continue;
        }

        const current = await readState(change.uri);
        const post = materializePostFromMixedContent(current ?? "", change.unifiedDiff);
        const reconstructedOriginal = reverseApplyUnifiedDiff(post, change.unifiedDiff).original;
        if (change.kind === "add" && reconstructedOriginal.length !== 0) {
          throw new Error("Historical addition did not reconstruct an empty pre-edit side.");
        }
        occurrence.originalContent = change.kind === "add" ? null : reconstructedOriginal;
        occurrence.postContent = post;
        states.set(change.uri.toString(), occurrence.originalContent);
      } catch (error) {
        occurrence.error = error instanceof Error ? error.message : String(error);
      }
    }

    const grouped = new Map<string, HistoricalOccurrence[]>();
    for (const occurrence of occurrences) {
      const key = reviewKey(occurrence.batch.turnId, occurrence.change.uri);
      const group = grouped.get(key) ?? [];
      group.push(occurrence);
      grouped.set(key, group);
    }
    const reconstructed = new Map<string, ReviewFile>();
    for (const [key, group] of grouped) {
      reconstructed.set(key, this.composeHistoricalFile(key, group));
    }

    const turnOrder: string[] = [];
    const turnTimestamps = new Map<string, string>();
    for (const batch of history) {
      if (!turnTimestamps.has(batch.turnId)) {
        turnOrder.push(batch.turnId);
        turnTimestamps.set(batch.turnId, batch.timestamp);
      }
    }
    const latestTurnId = turnOrder.at(-1);
    this.files.clear();
    this.turns.clear();
    this.interactiveTurnId = latestTurnId;
    for (const turnId of turnOrder) {
      this.turns.set(turnId, { turnId, timestamp: turnTimestamps.get(turnId) ?? "", fileKeys: [] });
    }
    for (const occurrence of occurrences) {
      const key = reviewKey(occurrence.batch.turnId, occurrence.change.uri);
      const turn = this.turns.get(occurrence.batch.turnId);
      if (!turn || turn.fileKeys.includes(key)) {
        continue;
      }
      const historical = reconstructed.get(key);
      if (!historical) {
        continue;
      }
      const previous = preserved.get(key);
      const preservedMatches = previous !== undefined
        && contentMatches(fullOriginalContent(previous), fullOriginalContent(historical))
        && contentMatches(fullPostContent(previous), fullPostContent(historical));
      const file = preservedMatches ? previous : cloneReviewFile(historical);
      if (!preservedMatches && storedDecisions[key]) {
        this.restoreStoredDecision(file, storedDecisions[key]);
      } else if (!preservedMatches && occurrence.batch.turnId !== latestTurnId) {
        if (file.status === "pending") {
          this.markKept(file);
        } else if (file.status === "reconstructionFailed") {
          file.status = "kept";
          file.markers = { addedLines: [], deletions: [], firstChangedLine: 0 };
        }
      }
      this.files.set(key, file);
      turn.fileKeys.push(key);
    }
    this.emit();
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
        if (status === "kept") {
          this.markKept(file);
        } else {
          if (status === "undone") {
            this.markUnresolvedBlocks(file, "undo");
          } else if (status === "pending" && file.blockDecisions) {
            file.blockDecisions = Object.fromEntries(
              Object.entries(file.blockDecisions).filter(([, decision]) => decision !== "undo"),
            );
          }
          file.status = status;
          file.message = undefined;
        }
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

  private composeHistoricalFile(key: string, group: HistoricalOccurrence[]): ReviewFile {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last || group.some((occurrence) => occurrence.error !== undefined)
      || first.originalContent === undefined) {
      const message = group.find((occurrence) => occurrence.error)?.error ?? "Historical review content could not be reconstructed.";
      const current = last?.postContent ?? null;
      let markers: ReviewMarkers = { addedLines: [], deletions: [], firstChangedLine: 0 };
      try {
        markers = last ? reviewMarkersFromUnifiedDiff(last.change.unifiedDiff) : markers;
      } catch {
        // The reconstruction-failed state carries the actionable explanation.
      }
      return {
        key,
        uri: first?.change.uri ?? last!.change.uri,
        ...(last?.change.moveUri ? { moveUri: last.change.moveUri } : {}),
        kind: last?.change.kind ?? first?.change.kind ?? "update",
        status: "reconstructionFailed",
        message,
        turnIds: [first?.batch.turnId ?? last!.batch.turnId],
        timestamp: first?.batch.timestamp ?? last!.batch.timestamp,
        originalContent: null,
        postContent: current,
        fullOriginalContent: null,
        fullPostContent: current,
        ...(current !== null ? { postHash: hashText(current) } : {}),
        markers,
      };
    }

    const original = first.originalContent;
    let post = original;
    let moveUri: vscode.Uri | undefined;
    try {
      for (const occurrence of group) {
        const change = occurrence.change;
        if (change.kind === "delete") {
          const expected = reverseApplyUnifiedDiff("", change.unifiedDiff).original;
          if (post === null || !contentMatches(post, expected)) {
            throw new Error("Historical delete did not match the composed turn state.");
          }
          post = null;
        } else if (change.kind === "add") {
          if (post !== null) {
            throw new Error("Historical add targeted a path that already existed in the composed turn state.");
          }
          post = materializePostFromMixedContent("", change.unifiedDiff);
        } else {
          if (post === null) {
            throw new Error("Historical update targeted a path that did not exist in the composed turn state.");
          }
          post = materializePostFromMixedContent(post, change.unifiedDiff);
          moveUri = change.kind === "move" ? change.moveUri : moveUri;
        }
      }
      const markers = computeReviewMarkers(original ?? "", post ?? "");
      return {
        key,
        uri: first.change.uri,
        ...(moveUri ? { moveUri } : {}),
        kind: composedKind(original, post, moveUri),
        status: "pending",
        turnIds: [first.batch.turnId],
        timestamp: first.batch.timestamp,
        originalContent: original,
        postContent: post,
        fullOriginalContent: original,
        fullPostContent: post,
        ...(original !== null ? { originalHash: hashText(original) } : {}),
        ...(post !== null ? { postHash: hashText(post) } : {}),
        markers,
      };
    } catch (error) {
      return {
        key,
        uri: first.change.uri,
        ...(moveUri ? { moveUri } : {}),
        kind: last.change.kind,
        status: "reconstructionFailed",
        message: error instanceof Error ? error.message : String(error),
        turnIds: [first.batch.turnId],
        timestamp: first.batch.timestamp,
        originalContent: null,
        postContent: last.postContent ?? null,
        fullOriginalContent: null,
        fullPostContent: last.postContent ?? null,
        ...(last.postContent !== undefined && last.postContent !== null ? { postHash: hashText(last.postContent) } : {}),
        markers: { addedLines: [], deletions: [], firstChangedLine: 0 },
      };
    }
  }

  private restoreStoredDecision(file: ReviewFile, stored: StoredReviewDecision): void {
    const blocks = immutableBlocks(file);
    const blockIds = new Set(blocks.map((block) => block.id));
    const decisions = Object.fromEntries(
      Object.entries(stored.blockDecisions).filter(([blockId, decision]) => blockIds.has(blockId) && (decision === "keep" || decision === "undo")),
    ) as Record<string, ReviewBlockDecision>;
    if (Object.keys(decisions).length === 0) {
      return;
    }
    const original = fullOriginalContent(file);
    const post = fullPostContent(file);
    const resolvedOriginal = materializeDecisionSide(original ?? "", post ?? "", blocks, decisions, "original");
    const resolvedPost = materializeDecisionSide(original ?? "", post ?? "", blocks, decisions, "post");
    const kept = Object.values(decisions).filter((decision) => decision === "keep").length;
    const undone = Object.values(decisions).filter((decision) => decision === "undo").length;
    file.blockDecisions = decisions;
    file.originalContent = original === null && kept === 0 ? null : resolvedOriginal;
    file.postContent = post === null && undone === 0 ? null : resolvedPost;
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
    const remaining = blocks.length - Object.keys(decisions).length;
    file.markers = remaining > 0
      ? computeReviewMarkers(file.originalContent ?? "", file.postContent ?? "")
      : { addedLines: [], deletions: [], firstChangedLine: 0 };
    file.status = remaining > 0 ? "pending" : undone > 0 ? "undone" : "kept";
    file.message = undefined;
  }

  private async reconstruct(change: FileChange, turnId: string, timestamp: string): Promise<ReviewFile> {
    const key = reviewKey(turnId, change.uri);
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
    const currentBlock = computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "")
      .find((candidate) => candidate.id === blockId);
    const immutableId = currentBlock ? immutableBlockId(file, currentBlock) : undefined;
    const resolved = resolveReviewBlock(file.originalContent ?? "", file.postContent ?? "", blockId, resolution);
    if (!resolved) {
      return false;
    }
    if (immutableId) {
      file.blockDecisions = { ...(file.blockDecisions ?? {}), [immutableId]: resolution };
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
    this.markUnresolvedBlocks(file, "keep");
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

  private markUnresolvedBlocks(file: ReviewFile, decision: ReviewBlockDecision): void {
    const decisions = { ...(file.blockDecisions ?? {}) };
    for (const block of immutableBlocks(file)) {
      if (decisions[block.id] === undefined) {
        decisions[block.id] = decision;
      }
    }
    if (Object.keys(decisions).length > 0) {
      file.blockDecisions = decisions;
    }
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
