import { promises as fs } from "node:fs";
import * as path from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function normalizeSessionId(value: string): string {
  const sessionId = value.trim().toLowerCase();
  if (!SESSION_ID.test(sessionId)) {
    throw new Error("Enter a Codex session ID in UUID form, such as 00000000-0000-0000-0000-000000000000.");
  }
  return sessionId;
}

export function dateDirectory(codexHome: string, date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return path.join(codexHome, "sessions", year, month, day);
}

export function recentDateDirectories(codexHome: string, now: Date, days: number): string[] {
  const count = Math.max(1, Math.floor(days));
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  const directories: string[] = [];
  for (let index = 0; index < count; index += 1) {
    directories.push(dateDirectory(codexHome, cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return directories;
}

export async function jsonlFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function recentRolloutFiles(codexHome: string, now: Date, days: number): Promise<string[]> {
  const groups = await Promise.all(recentDateDirectories(codexHome, now, days).map(jsonlFiles));
  return groups.flat();
}

async function childDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function findRolloutBySessionId(codexHome: string, value: string): Promise<string | undefined> {
  const sessionId = normalizeSessionId(value);
  const sessionsRoot = path.join(codexHome, "sessions");
  const years = await childDirectories(sessionsRoot);
  for (const year of years.sort().reverse()) {
    const months = await childDirectories(year);
    for (const month of months.sort().reverse()) {
      const days = await childDirectories(month);
      for (const day of days.sort().reverse()) {
        const match = (await jsonlFiles(day)).find((filePath) => path.basename(filePath).toLowerCase().includes(sessionId));
        if (match) {
          return match;
        }
      }
    }
  }
  return undefined;
}
