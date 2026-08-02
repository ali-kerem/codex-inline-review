import { hashText } from "./hash";

export type HunkLineKind = "context" | "add" | "remove";

export interface HunkLine {
  kind: HunkLineKind;
  text: string;
  noNewline: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  eol: "\n" | "\r\n";
}

export interface TextShape {
  lines: string[];
  eol: "\n" | "\r\n";
  finalNewline: boolean;
}

export interface ReverseResult {
  original: string;
  hunks: DiffHunk[];
}

export interface DeletionMarker {
  line: number;
  removedText: string;
}

export interface ReviewMarkers {
  addedLines: number[];
  deletions: DeletionMarker[];
  firstChangedLine: number;
}

export interface ReviewBlock {
  id: string;
  originalStart: number;
  originalLines: string[];
  postStart: number;
  postLines: string[];
}

export interface ResolvedReviewBlock {
  originalContent: string;
  postContent: string;
  block: ReviewBlock;
}

interface ChangeSpan {
  start: number;
  end: number;
}

export function reviewBlockStarts(markers: ReviewMarkers): number[] {
  const added = [...new Set(markers.addedLines)].sort((a, b) => a - b);
  const spans: ChangeSpan[] = markers.deletions.map((deletion) => ({ start: deletion.line, end: deletion.line }));
  for (let index = 0; index < added.length;) {
    const start = added[index];
    if (start === undefined) {
      break;
    }
    let last = start;
    index += 1;
    while (added[index] === last + 1) {
      last = added[index] ?? last;
      index += 1;
    }
    spans.push({ start, end: last + 1 });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const starts: number[] = [];
  let active: ChangeSpan | undefined;
  for (const span of spans) {
    if (!active || span.start > active.end) {
      starts.push(span.start);
      active = { ...span };
      continue;
    }
    active.end = Math.max(active.end, span.end);
  }
  return starts.length > 0 ? starts : [markers.firstChangedLine];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/u;

export function splitText(content: string): TextShape {
  const eol: "\n" | "\r\n" = content.includes("\r\n") ? "\r\n" : "\n";
  if (content.length === 0) {
    return { lines: [], eol, finalNewline: false };
  }
  const finalNewline = content.endsWith("\n");
  const body = finalNewline ? content.slice(0, content.endsWith("\r\n") ? -2 : -1) : content;
  return { lines: body.split(/\r?\n/u), eol, finalNewline };
}

export function joinText(shape: TextShape): string {
  if (shape.lines.length === 0) {
    return "";
  }
  return shape.lines.join(shape.eol) + (shape.finalNewline ? shape.eol : "");
}

export function parseUnifiedDiff(input: string): ParsedDiff {
  const eol: "\n" | "\r\n" = input.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = input.split("\n").map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
  if (rawLines.at(-1) === "") {
    rawLines.pop();
  }
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < rawLines.length) {
    const header = HUNK_HEADER.exec(rawLines[index] ?? "");
    if (!header) {
      index += 1;
      continue;
    }
    const hunk: DiffHunk = {
      oldStart: Number(header[1]),
      oldCount: header[2] === undefined ? 1 : Number(header[2]),
      newStart: Number(header[3]),
      newCount: header[4] === undefined ? 1 : Number(header[4]),
      lines: [],
    };
    index += 1;
    while (index < rawLines.length && !HUNK_HEADER.test(rawLines[index] ?? "")) {
      const line = rawLines[index] ?? "";
      if (line === "\\ No newline at end of file") {
        const previous = hunk.lines.at(-1);
        if (!previous) {
          throw new Error("Missing-newline marker has no preceding diff line.");
        }
        previous.noNewline = true;
        index += 1;
        continue;
      }
      if (line.startsWith("diff --git ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
        break;
      }
      const prefix = line[0];
      if (prefix !== " " && prefix !== "+" && prefix !== "-") {
        break;
      }
      hunk.lines.push({
        kind: prefix === " " ? "context" : prefix === "+" ? "add" : "remove",
        text: line.slice(1),
        noNewline: false,
      });
      index += 1;
    }
    const oldCount = hunk.lines.filter((line) => line.kind !== "add").length;
    const newCount = hunk.lines.filter((line) => line.kind !== "remove").length;
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
      throw new Error(`Hunk count mismatch: expected ${hunk.oldCount}/${hunk.newCount}, parsed ${oldCount}/${newCount}.`);
    }
    hunks.push(hunk);
  }
  if (input.length > 0 && hunks.length === 0) {
    throw new Error("Unified diff contains no valid hunks.");
  }
  return { hunks, eol };
}

function sideHasNoNewline(hunk: DiffHunk, side: "old" | "new"): boolean {
  return hunk.lines.some((line) => line.noNewline && (side === "old" ? line.kind !== "add" : line.kind !== "remove"));
}

export function reverseApplyUnifiedDiff(postContent: string, unifiedDiff: string): ReverseResult {
  if (unifiedDiff.length === 0) {
    return { original: postContent, hunks: [] };
  }
  const parsed = parseUnifiedDiff(unifiedDiff);
  const post = splitText(postContent);
  const resultLines = [...post.lines];
  let originalFinalNewline = post.finalNewline;
  const descending = [...parsed.hunks].sort((a, b) => b.newStart - a.newStart);

  for (const hunk of descending) {
    const newIndex = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    const expectedNew = hunk.lines.filter((line) => line.kind !== "remove").map((line) => line.text);
    const replacementOld = hunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
    const actual = resultLines.slice(newIndex, newIndex + expectedNew.length);
    if (actual.length !== expectedNew.length || actual.some((line, i) => line !== expectedNew[i])) {
      throw new Error(`Post-edit content does not match hunk at new line ${hunk.newStart}.`);
    }
    const touchesNewEof = newIndex + expectedNew.length === resultLines.length;
    if (touchesNewEof) {
      if (expectedNew.length > 0) {
        const newNoNewline = sideHasNoNewline(hunk, "new");
        if (newNoNewline === post.finalNewline) {
          throw new Error("Post-edit final-newline state does not match the unified diff.");
        }
      }
      originalFinalNewline = replacementOld.length > 0 ? !sideHasNoNewline(hunk, "old") : false;
    }
    resultLines.splice(newIndex, expectedNew.length, ...replacementOld);
  }

  return {
    original: joinText({ lines: resultLines, eol: postContent.length > 0 ? post.eol : parsed.eol, finalNewline: originalFinalNewline }),
    hunks: parsed.hunks,
  };
}

export function contentToUnifiedDiff(content: string, kind: "add" | "delete"): string {
  const shape = splitText(content);
  const count = shape.lines.length;
  const oldRange = kind === "delete" ? (count === 0 ? "0,0" : `1,${count}`) : "0,0";
  const newRange = kind === "add" ? (count === 0 ? "0,0" : `1,${count}`) : "0,0";
  const prefix = kind === "add" ? "+" : "-";
  const output = [`@@ -${oldRange} +${newRange} @@`];
  for (const line of shape.lines) {
    output.push(`${prefix}${line}`);
  }
  if (count > 0 && !shape.finalNewline) {
    output.push("\\ No newline at end of file");
  }
  return output.join(shape.eol) + shape.eol;
}

type Edit = { kind: "equal" | "add" | "remove"; text: string };

function myersDiff(before: string[], after: string[]): Edit[] {
  const maximum = before.length + after.length;
  let frontier = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let depth = 0; depth <= maximum; depth += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let x = diagonal === -depth || (diagonal !== depth && right < down) ? down : right + 1;
      if (!Number.isFinite(x)) {
        x = 0;
      }
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);
      if (x >= before.length && y >= after.length) {
        return backtrack(trace, before, after);
      }
    }
  }
  return [];
}

function createReviewBlock(originalStart: number, originalLines: string[], postStart: number, postLines: string[]): ReviewBlock {
  const identity = JSON.stringify([originalStart, originalLines, postStart, postLines]);
  return {
    id: hashText(identity).slice(0, 20),
    originalStart,
    originalLines,
    postStart,
    postLines,
  };
}

export function computeReviewBlocks(originalContent: string, postContent: string): ReviewBlock[] {
  const original = splitText(originalContent);
  const post = splitText(postContent);
  if (original.lines.length + post.lines.length > 5_000) {
    let prefix = 0;
    while (prefix < original.lines.length && prefix < post.lines.length && original.lines[prefix] === post.lines[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < original.lines.length - prefix
      && suffix < post.lines.length - prefix
      && original.lines[original.lines.length - 1 - suffix] === post.lines[post.lines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    if (prefix + suffix < Math.max(original.lines.length, post.lines.length)) {
      return [createReviewBlock(
        prefix,
        original.lines.slice(prefix, original.lines.length - suffix),
        prefix,
        post.lines.slice(prefix, post.lines.length - suffix),
      )];
    }
  }

  const edits = myersDiff(original.lines, post.lines);
  const blocks: ReviewBlock[] = [];
  let originalLine = 0;
  let postLine = 0;
  let originalStart = 0;
  let postStart = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = (): void => {
    if (removed.length > 0 || added.length > 0) {
      blocks.push(createReviewBlock(originalStart, removed, postStart, added));
      removed = [];
      added = [];
    }
  };

  for (const edit of edits) {
    if (edit.kind === "equal") {
      flush();
      originalLine += 1;
      postLine += 1;
      continue;
    }
    if (removed.length === 0 && added.length === 0) {
      originalStart = originalLine;
      postStart = postLine;
    }
    if (edit.kind === "remove") {
      removed.push(edit.text);
      originalLine += 1;
    } else {
      added.push(edit.text);
      postLine += 1;
    }
  }
  flush();

  if (blocks.length === 0 && originalContent !== postContent) {
    const originalStartAt = Math.max(0, original.lines.length - 1);
    const postStartAt = Math.max(0, post.lines.length - 1);
    blocks.push(createReviewBlock(
      originalStartAt,
      original.lines.slice(originalStartAt),
      postStartAt,
      post.lines.slice(postStartAt),
    ));
  }
  return blocks;
}

export function resolveReviewBlock(
  originalContent: string,
  postContent: string,
  blockId: string,
  resolution: "keep" | "undo",
): ResolvedReviewBlock | undefined {
  const block = computeReviewBlocks(originalContent, postContent).find((candidate) => candidate.id === blockId);
  if (!block) {
    return undefined;
  }
  const original = splitText(originalContent);
  const post = splitText(postContent);
  const touchesBothEnds = block.originalStart + block.originalLines.length === original.lines.length
    && block.postStart + block.postLines.length === post.lines.length;
  if (resolution === "keep") {
    original.lines.splice(block.originalStart, block.originalLines.length, ...block.postLines);
    if (touchesBothEnds) {
      original.finalNewline = post.finalNewline;
    }
  } else {
    post.lines.splice(block.postStart, block.postLines.length, ...block.originalLines);
    if (touchesBothEnds) {
      post.finalNewline = original.finalNewline;
    }
  }
  return {
    originalContent: joinText(original),
    postContent: joinText(post),
    block,
  };
}

function backtrack(trace: Map<number, number>[], before: string[], after: string[]): Edit[] {
  let x = before.length;
  let y = after.length;
  const edits: Edit[] = [];
  for (let depth = trace.length - 1; depth >= 0; depth -= 1) {
    const frontier = trace[depth] ?? new Map<number, number>();
    const diagonal = x - y;
    const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal = diagonal === -depth || (diagonal !== depth && right < down) ? diagonal + 1 : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      edits.push({ kind: "equal", text: before[x - 1] ?? "" });
      x -= 1;
      y -= 1;
    }
    if (depth === 0) {
      break;
    }
    if (x === previousX) {
      edits.push({ kind: "add", text: after[y - 1] ?? "" });
      y -= 1;
    } else {
      edits.push({ kind: "remove", text: before[x - 1] ?? "" });
      x -= 1;
    }
  }
  return edits.reverse();
}

export function computeReviewMarkers(originalContent: string, postContent: string): ReviewMarkers {
  const original = splitText(originalContent);
  const post = splitText(postContent);
  if (original.lines.length + post.lines.length > 5_000) {
    let prefix = 0;
    while (prefix < original.lines.length && prefix < post.lines.length && original.lines[prefix] === post.lines[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < original.lines.length - prefix
      && suffix < post.lines.length - prefix
      && original.lines[original.lines.length - 1 - suffix] === post.lines[post.lines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const addedLines = Array.from({ length: Math.max(0, post.lines.length - prefix - suffix) }, (_, index) => prefix + index);
    const removed = original.lines.slice(prefix, original.lines.length - suffix);
    return {
      addedLines,
      deletions: removed.length > 0 ? [{ line: prefix, removedText: removed.join(original.eol) }] : [],
      firstChangedLine: prefix,
    };
  }
  const edits = myersDiff(original.lines, post.lines);
  const addedLines: number[] = [];
  const deletions: DeletionMarker[] = [];
  let currentLine = 0;
  let firstChangedLine = Number.POSITIVE_INFINITY;
  for (let index = 0; index < edits.length;) {
    const edit = edits[index];
    if (!edit) {
      break;
    }
    if (edit.kind === "equal") {
      currentLine += 1;
      index += 1;
      continue;
    }
    firstChangedLine = Math.min(firstChangedLine, currentLine);
    if (edit.kind === "add") {
      while (edits[index]?.kind === "add") {
        addedLines.push(currentLine);
        currentLine += 1;
        index += 1;
      }
      continue;
    }
    const removed: string[] = [];
    while (edits[index]?.kind === "remove") {
      removed.push(edits[index]?.text ?? "");
      index += 1;
    }
    deletions.push({ line: Math.max(0, currentLine), removedText: removed.join(original.eol) });
  }
  return {
    addedLines,
    deletions,
    firstChangedLine: Number.isFinite(firstChangedLine) ? firstChangedLine : 0,
  };
}

export function reviewMarkersFromUnifiedDiff(unifiedDiff: string): ReviewMarkers {
  const parsed = parseUnifiedDiff(unifiedDiff);
  const addedLines: number[] = [];
  const deletions: DeletionMarker[] = [];
  let firstChangedLine = Number.POSITIVE_INFINITY;
  for (const hunk of parsed.hunks) {
    let currentLine = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
    for (let index = 0; index < hunk.lines.length;) {
      const line = hunk.lines[index];
      if (!line) {
        break;
      }
      if (line.kind === "context") {
        currentLine += 1;
        index += 1;
        continue;
      }
      firstChangedLine = Math.min(firstChangedLine, currentLine);
      if (line.kind === "add") {
        addedLines.push(currentLine);
        currentLine += 1;
        index += 1;
        continue;
      }
      const removed: string[] = [];
      while (hunk.lines[index]?.kind === "remove") {
        removed.push(hunk.lines[index]?.text ?? "");
        index += 1;
      }
      deletions.push({ line: Math.max(0, currentLine), removedText: removed.join(parsed.eol) });
    }
  }
  return {
    addedLines,
    deletions,
    firstChangedLine: Number.isFinite(firstChangedLine) ? firstChangedLine : 0,
  };
}
