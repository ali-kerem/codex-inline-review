import type * as vscode from "vscode";
import { contentToUnifiedDiff } from "./diff";
import type { ChangeBatch, ChangeKind, FileChange } from "./model";

export interface SourcePosition {
  identity: string;
  offset: number;
}

export interface WorkspacePathResolver {
  resolve(candidate: string, allowMissing: boolean): Promise<vscode.Uri | undefined>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function normalizedKind(rawType: unknown, movePath: unknown): ChangeKind | undefined {
  if (typeof movePath === "string" && movePath.length > 0) {
    return "move";
  }
  return rawType === "update" || rawType === "add" || rawType === "delete" ? rawType : undefined;
}

function normalizedDiff(change: UnknownRecord, kind: ChangeKind): string | undefined {
  if (typeof change.unified_diff === "string") {
    return change.unified_diff;
  }
  if ((kind === "add" || kind === "delete") && typeof change.content === "string") {
    return contentToUnifiedDiff(change.content, kind);
  }
  return undefined;
}

export class RolloutEventAdapter {
  public constructor(private readonly paths: WorkspacePathResolver) {}

  public async adapt(line: string, source: SourcePosition): Promise<ChangeBatch | undefined> {
    let outer: UnknownRecord | undefined;
    try {
      outer = record(JSON.parse(line));
    } catch {
      return undefined;
    }
    const payload = record(outer?.payload);
    if (outer?.type !== "event_msg" || payload?.type !== "patch_apply_end" || payload.success !== true || payload.status !== "completed") {
      return undefined;
    }
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    const callId = typeof payload.call_id === "string" ? payload.call_id : "unknown-call";
    const rawChanges = record(payload.changes);
    if (!turnId || !rawChanges) {
      return undefined;
    }

    const changes: FileChange[] = [];
    for (const [candidatePath, rawChange] of Object.entries(rawChanges)) {
      const change = record(rawChange);
      if (!change) {
        continue;
      }
      const movePath = typeof change.move_path === "string" ? change.move_path : undefined;
      const kind = normalizedKind(change.type, movePath);
      if (!kind) {
        continue;
      }
      const uri = await this.paths.resolve(candidatePath, kind === "delete" || kind === "move");
      if (!uri) {
        continue;
      }
      const moveUri = movePath ? await this.paths.resolve(movePath, false) : undefined;
      if (kind === "move" && !moveUri) {
        continue;
      }
      const unifiedDiff = normalizedDiff(change, kind);
      if (unifiedDiff === undefined) {
        continue;
      }
      changes.push({ uri, kind, unifiedDiff, ...(moveUri ? { moveUri } : {}) });
    }
    if (changes.length === 0) {
      return undefined;
    }
    const timestamp = typeof outer?.timestamp === "string" ? outer.timestamp : undefined;
    if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
      return undefined;
    }
    return {
      source: "rollout",
      eventId: `${source.identity}:${source.offset}:${callId}:${turnId}`,
      logicalEventId: `${callId}:${turnId}`,
      turnId,
      timestamp,
      changes,
    };
  }
}
