import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { JsonlTailer, fileIdentity, type TailCheckpoint } from "./jsonlTailer";
import type { ChangeBatch, ChangeEventSource, SourceDiagnostics } from "./model";
import { RolloutEventAdapter } from "./rolloutAdapter";
import {
  batchPassesForkBoundary,
  inspectRolloutStart,
  rolloutLogicalEventIds,
  type RolloutStartInspection,
} from "./rolloutStart";

export interface CheckpointStorage {
  load(): Record<string, TailCheckpoint>;
  save(checkpoints: Record<string, TailCheckpoint>): Promise<void>;
}

interface TrackedRollout {
  checkpoint: TailCheckpoint;
  forkTimestampMs?: number;
  parentLogicalEventIds?: Set<string>;
  startInspectionPending: boolean;
}

interface ForkInspection {
  start: RolloutStartInspection;
  parentLogicalEventIds?: Set<string>;
}

function dateDirectory(codexHome: string, date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return path.join(codexHome, "sessions", year, month, day);
}

async function jsonlFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export class RolloutEventSource implements ChangeEventSource, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ChangeBatch>();
  public readonly onDidChangeBatch = this.emitter.event;
  private readonly tailer = new JsonlTailer();
  private readonly tracked = new Map<string, TrackedRollout>();
  private readonly seenEvents = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = true;
  private polling = false;
  private firstScan = true;
  private activeDirectory = "";
  private newestRollout: string | undefined;
  private newestRolloutMtime = 0;
  private lastProcessedOffset: number | undefined;

  public constructor(
    private readonly codexHome: string,
    private readonly pollIntervalMs: number,
    private readonly adapter: RolloutEventAdapter,
    private readonly checkpoints: CheckpointStorage,
    private readonly output: vscode.OutputChannel,
  ) {}

  public async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    await this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  public dispose(): void {
    void this.stop();
    this.emitter.dispose();
  }

  public getDiagnostics(): SourceDiagnostics {
    return {
      watchedSessionDirectory: this.activeDirectory || dateDirectory(this.codexHome, new Date()),
      ...(this.newestRollout ? { newestRollout: this.newestRollout } : {}),
      ...(this.lastProcessedOffset !== undefined ? { lastProcessedOffset: this.lastProcessedOffset } : {}),
    };
  }

  public async importRecent(seconds: number): Promise<number> {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error("Recent import window must be a finite non-negative number of seconds.");
    }
    const cutoffMs = Date.now() - seconds * 1000;
    const directories: string[] = [];
    const cursor = new Date(cutoffMs);
    cursor.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    while (cursor.getTime() <= today.getTime()) {
      directories.push(dateDirectory(this.codexHome, cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    let imported = 0;
    for (const directory of directories) {
      const files = await jsonlFiles(directory);
      for (const filePath of files) {
        let stats;
        try {
          stats = await fs.stat(filePath);
        } catch {
          continue;
        }
        this.observeNewest(filePath, stats.mtimeMs);
        if (stats.mtimeMs < cutoffMs) {
          continue;
        }
        const checkpoint: TailCheckpoint = { identity: fileIdentity(stats), offset: 0 };
        const inspection = await this.inspectFork(filePath, files);
        const result = await this.tailer.read(filePath, checkpoint);
        for (const line of result.lines) {
          const batch = await this.adapter.adapt(line.text, line);
          const timestampMs = batch ? Date.parse(batch.timestamp) : Number.NaN;
          if (batch
            && Number.isFinite(timestampMs)
            && timestampMs >= cutoffMs
            && batchPassesForkBoundary(
              batch.timestamp,
              batch.logicalEventId,
              inspection.start.forkTimestampMs,
              inspection.parentLogicalEventIds,
            )
            && this.remember(batch.eventId)) {
            this.emitter.fire(batch);
            imported += 1;
          }
        }
        if (directory === dateDirectory(this.codexHome, new Date())) {
          this.tracked.set(filePath, {
            checkpoint: result.checkpoint,
            ...(inspection.start.forkTimestampMs !== undefined ? { forkTimestampMs: inspection.start.forkTimestampMs } : {}),
            ...(inspection.parentLogicalEventIds ? { parentLogicalEventIds: inspection.parentLogicalEventIds } : {}),
            startInspectionPending: !inspection.start.complete,
          });
        }
      }
    }
    await this.persistCheckpoints();
    this.output.appendLine(`Imported ${imported} completed Codex change event(s) from the requested time window.`);
    return imported;
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const directory = dateDirectory(this.codexHome, new Date());
      if (directory !== this.activeDirectory) {
        const isRollover = this.activeDirectory.length > 0;
        this.activeDirectory = directory;
        this.firstScan = !isRollover;
      }
      const files = await jsonlFiles(directory);
      const stored = this.checkpoints.load();
      for (const filePath of files) {
        let stats;
        try {
          stats = await fs.stat(filePath);
        } catch {
          continue;
        }
        this.observeNewest(filePath, stats.mtimeMs);
        let tracked = this.tracked.get(filePath);
        if (!tracked) {
          const saved = stored[filePath];
          const identity = fileIdentity(stats);
          const inspection = await this.inspectFork(filePath, files);
          if (this.firstScan) {
            tracked = {
              checkpoint: await this.tailer.initialize(filePath, true),
              ...(inspection.start.forkTimestampMs !== undefined ? { forkTimestampMs: inspection.start.forkTimestampMs } : {}),
              ...(inspection.parentLogicalEventIds ? { parentLogicalEventIds: inspection.parentLogicalEventIds } : {}),
              startInspectionPending: !inspection.start.complete,
            };
          } else if (saved?.identity === identity && saved.offset <= stats.size) {
            tracked = {
              checkpoint: saved,
              ...(inspection.start.forkTimestampMs !== undefined ? { forkTimestampMs: inspection.start.forkTimestampMs } : {}),
              ...(inspection.parentLogicalEventIds ? { parentLogicalEventIds: inspection.parentLogicalEventIds } : {}),
              startInspectionPending: !inspection.start.complete,
            };
          } else {
            tracked = {
              checkpoint: await this.tailer.initialize(filePath, false),
              ...(inspection.start.forkTimestampMs !== undefined ? { forkTimestampMs: inspection.start.forkTimestampMs } : {}),
              ...(inspection.parentLogicalEventIds ? { parentLogicalEventIds: inspection.parentLogicalEventIds } : {}),
              startInspectionPending: !inspection.start.complete,
            };
          }
          this.tracked.set(filePath, tracked);
        }
        if (tracked.startInspectionPending) {
          const inspection = await this.inspectFork(filePath, files);
          tracked.startInspectionPending = !inspection.start.complete;
          tracked.forkTimestampMs = inspection.start.forkTimestampMs;
          tracked.parentLogicalEventIds = inspection.parentLogicalEventIds;
        }
        const result = await this.tailer.read(filePath, tracked.checkpoint);
        if (result.replaced || result.truncated) {
          const inspection = await this.inspectFork(filePath, files);
          tracked.startInspectionPending = !inspection.start.complete;
          tracked.forkTimestampMs = inspection.start.forkTimestampMs;
          tracked.parentLogicalEventIds = inspection.parentLogicalEventIds;
        }
        tracked.checkpoint = result.checkpoint;
        for (const line of result.lines) {
          const batch = await this.adapter.adapt(line.text, line);
          if (batch
            && batchPassesForkBoundary(
              batch.timestamp,
              batch.logicalEventId,
              tracked.forkTimestampMs,
              tracked.parentLogicalEventIds,
            )
            && this.remember(batch.eventId)) {
            this.emitter.fire(batch);
          }
        }
        this.lastProcessedOffset = result.checkpoint.offset;
      }
      this.firstScan = false;
      await this.persistCheckpoints();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`Rollout watcher error: ${message}`);
    } finally {
      this.polling = false;
    }
  }

  private observeNewest(filePath: string, mtimeMs: number): void {
    if (mtimeMs >= this.newestRolloutMtime) {
      this.newestRolloutMtime = mtimeMs;
      this.newestRollout = filePath;
    }
  }

  private async inspectFork(filePath: string, siblingFiles: string[]): Promise<ForkInspection> {
    const start = await inspectRolloutStart(filePath);
    if (!start.forkedFromId) {
      return { start };
    }
    const candidates = new Set([...siblingFiles, ...this.tracked.keys(), ...Object.keys(this.checkpoints.load())]);
    const parentPath = [...candidates].find((candidate) => candidate !== filePath && path.basename(candidate).includes(start.forkedFromId ?? ""));
    if (!parentPath) {
      return { start };
    }
    try {
      return { start, parentLogicalEventIds: await rolloutLogicalEventIds(parentPath) };
    } catch {
      return { start };
    }
  }

  private remember(eventId: string): boolean {
    if (this.seenEvents.has(eventId)) {
      return false;
    }
    this.seenEvents.add(eventId);
    if (this.seenEvents.size > 10_000) {
      const oldest = this.seenEvents.values().next().value as string | undefined;
      if (oldest) {
        this.seenEvents.delete(oldest);
      }
    }
    return true;
  }

  private async persistCheckpoints(): Promise<void> {
    const values: Record<string, TailCheckpoint> = {};
    for (const [filePath, tracked] of this.tracked) {
      values[filePath] = tracked.checkpoint;
    }
    await this.checkpoints.save(values);
  }
}
