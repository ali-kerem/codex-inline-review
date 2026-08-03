import type * as vscode from "vscode";

export type ChangeKind = "update" | "add" | "delete" | "move";
export type ChangeSource = "rollout" | "appServer";

export interface FileChange {
  uri: vscode.Uri;
  kind: ChangeKind;
  unifiedDiff: string;
  moveUri?: vscode.Uri;
}

export interface ChangeBatch {
  source: ChangeSource;
  eventId: string;
  logicalEventId: string;
  turnId: string;
  timestamp: string;
  changes: FileChange[];
}

export interface SourceDiagnostics {
  watchedSessionDirectory?: string;
  newestRollout?: string;
  lastProcessedOffset?: number;
  trackedRollouts?: number;
  pinnedSessionId?: string;
  pinnedRollout?: string;
}

export interface ChangeEventSource {
  readonly onDidChangeBatch: vscode.Event<ChangeBatch>;
  start(): Promise<void>;
  stop(): Promise<void>;
  importRecent?(seconds: number): Promise<number>;
  getDiagnostics(): SourceDiagnostics;
}
