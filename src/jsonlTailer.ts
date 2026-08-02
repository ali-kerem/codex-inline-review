import { promises as fs, type Stats } from "node:fs";

export interface TailCheckpoint {
  identity: string;
  offset: number;
}

export interface TailedLine {
  identity: string;
  offset: number;
  text: string;
}

export interface TailResult {
  lines: TailedLine[];
  checkpoint: TailCheckpoint;
  replaced: boolean;
  truncated: boolean;
}

export function fileIdentity(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
}

export class JsonlTailer {
  public async initialize(filePath: string, fromEnd: boolean): Promise<TailCheckpoint> {
    const stats = await fs.stat(filePath);
    return { identity: fileIdentity(stats), offset: fromEnd ? stats.size : 0 };
  }

  public async read(filePath: string, previous: TailCheckpoint): Promise<TailResult> {
    const stats = await fs.stat(filePath);
    const identity = fileIdentity(stats);
    const replaced = identity !== previous.identity;
    const truncated = !replaced && stats.size < previous.offset;
    const start = replaced || truncated ? 0 : previous.offset;
    if (stats.size <= start) {
      return { lines: [], checkpoint: { identity, offset: start }, replaced, truncated };
    }
    const length = stats.size - start;
    const handle = await fs.open(filePath, "r");
    let bytesRead = 0;
    const buffer = Buffer.alloc(length);
    try {
      const result = await handle.read(buffer, 0, length, start);
      bytesRead = result.bytesRead;
    } finally {
      await handle.close();
    }
    const data = buffer.subarray(0, bytesRead);
    const lines: TailedLine[] = [];
    let lineStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0x0a) {
        continue;
      }
      let lineEnd = index;
      if (lineEnd > lineStart && data[lineEnd - 1] === 0x0d) {
        lineEnd -= 1;
      }
      lines.push({ identity, offset: start + lineStart, text: data.subarray(lineStart, lineEnd).toString("utf8") });
      lineStart = index + 1;
    }
    return {
      lines,
      checkpoint: { identity, offset: start + lineStart },
      replaced,
      truncated,
    };
  }
}
