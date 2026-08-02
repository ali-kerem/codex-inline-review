import type * as vscode from "vscode";
import type { ChangeBatch, ChangeKind, FileChange } from "./model";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

export interface AppServerPathResolver {
  resolve(candidate: string, allowMissing: boolean): Promise<vscode.Uri | undefined>;
}

/**
 * Normalizes documented app-server item/completed fileChange notifications.
 * No source starts an app-server today; this adapter is the future integration seam.
 */
export class AppServerEventAdapter {
  public constructor(private readonly paths: AppServerPathResolver) {}

  public async adapt(message: unknown): Promise<ChangeBatch | undefined> {
    const envelope = record(message);
    const params = record(envelope?.params);
    const item = record(params?.item);
    if (envelope?.method !== "item/completed" || item?.type !== "fileChange" || item.status !== "completed" || !Array.isArray(item.changes)) {
      return undefined;
    }
    const turnId = typeof params?.turnId === "string" ? params.turnId : undefined;
    const itemId = typeof item.id === "string" ? item.id : undefined;
    if (!turnId || !itemId) {
      return undefined;
    }
    const changes: FileChange[] = [];
    for (const entry of item.changes) {
      const change = record(entry);
      const path = typeof change?.path === "string" ? change.path : undefined;
      const diff = typeof change?.diff === "string" ? change.diff : undefined;
      const rawKind = change?.kind;
      const kind: ChangeKind | undefined = rawKind === "update" || rawKind === "add" || rawKind === "delete" || rawKind === "move" ? rawKind : undefined;
      if (!path || diff === undefined || !kind) {
        continue;
      }
      const uri = await this.paths.resolve(path, kind === "delete" || kind === "move");
      if (uri) {
        changes.push({ uri, kind, unifiedDiff: diff });
      }
    }
    if (changes.length === 0) {
      return undefined;
    }
    return {
      source: "appServer",
      eventId: `appServer:${turnId}:${itemId}`,
      logicalEventId: `${turnId}:${itemId}`,
      turnId,
      timestamp: new Date().toISOString(),
      changes,
    };
  }
}
