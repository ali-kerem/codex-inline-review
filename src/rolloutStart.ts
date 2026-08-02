import { createReadStream, promises as fs } from "node:fs";
import { createInterface } from "node:readline";

type UnknownRecord = Record<string, unknown>;

export interface RolloutStartInspection {
  complete: boolean;
  forkTimestampMs?: number;
  forkedFromId?: string;
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

export async function inspectRolloutStart(filePath: string, maximumBytes = 16 * 1024 * 1024): Promise<RolloutStartInspection> {
  const handle = await fs.open(filePath, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  let foundNewline = false;
  try {
    while (total < maximumBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maximumBytes - total));
      const result = await handle.read(chunk, 0, chunk.length, total);
      if (result.bytesRead === 0) {
        return { complete: false };
      }
      const bytes = chunk.subarray(0, result.bytesRead);
      const newline = bytes.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(bytes.subarray(0, newline));
        foundNewline = true;
        break;
      }
      chunks.push(bytes);
      total += result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  if (!foundNewline) {
    return { complete: false };
  }

  const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/u, "");
  let outer: UnknownRecord | undefined;
  try {
    outer = record(JSON.parse(line));
  } catch {
    return { complete: true };
  }
  const payload = record(outer?.payload);
  if (outer?.type !== "session_meta" || typeof payload?.forked_from_id !== "string") {
    return { complete: true };
  }
  const timestamp = typeof outer.timestamp === "string"
    ? outer.timestamp
    : typeof payload.timestamp === "string"
      ? payload.timestamp
      : undefined;
  const forkTimestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(forkTimestampMs)
    ? { complete: true, forkTimestampMs, forkedFromId: payload.forked_from_id }
    : { complete: true, forkedFromId: payload.forked_from_id };
}

export async function rolloutLogicalEventIds(filePath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    let outer: UnknownRecord | undefined;
    try {
      outer = record(JSON.parse(line));
    } catch {
      continue;
    }
    const payload = record(outer?.payload);
    if (outer?.type !== "event_msg" || payload?.type !== "patch_apply_end") {
      continue;
    }
    if (typeof payload.call_id === "string" && typeof payload.turn_id === "string") {
      ids.add(`${payload.call_id}:${payload.turn_id}`);
    }
  }
  return ids;
}

export function batchPassesForkBoundary(
  timestamp: string,
  logicalEventId: string,
  forkTimestampMs: number | undefined,
  parentLogicalEventIds?: ReadonlySet<string>,
): boolean {
  if (forkTimestampMs === undefined) {
    return true;
  }
  if (parentLogicalEventIds) {
    return !parentLogicalEventIds.has(logicalEventId);
  }
  const eventTimestampMs = Date.parse(timestamp);
  return Number.isFinite(eventTimestampMs) && eventTimestampMs > forkTimestampMs + 1_000;
}
