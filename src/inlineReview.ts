import { computeReviewBlocks, splitText } from "./diff";

export type InlineReviewLineKind = "context" | "removed" | "added";

export interface InlineReviewLine {
  kind: InlineReviewLineKind;
  text: string;
  blockId?: string;
}

export interface InlineReviewRange {
  kind: "removed" | "added";
  line: number;
  start: number;
  end: number;
}

export interface InlineReviewBlockAnchor {
  id: string;
  line: number;
}

export interface InlineReviewModel {
  content: string;
  lines: InlineReviewLine[];
  changedRanges: InlineReviewRange[];
  blocks: InlineReviewBlockAnchor[];
}

function changedSpan(before: string, after: string): { beforeStart: number; beforeEnd: number; afterStart: number; afterEnd: number } | undefined {
  let prefix = 0;
  const maximumPrefix = Math.min(before.length, after.length);
  while (prefix < maximumPrefix && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  if (beforeEnd === prefix && afterEnd === prefix) {
    return undefined;
  }
  return { beforeStart: prefix, beforeEnd, afterStart: prefix, afterEnd };
}

export function createInlineReviewModel(originalContent: string, postContent: string): InlineReviewModel {
  const original = splitText(originalContent);
  const post = splitText(postContent);
  const reviewBlocks = computeReviewBlocks(originalContent, postContent);
  const lines: InlineReviewLine[] = [];
  const changedRanges: InlineReviewRange[] = [];
  const blocks: InlineReviewBlockAnchor[] = [];
  let postLine = 0;

  for (const block of reviewBlocks) {
    while (postLine < block.postStart) {
      lines.push({ kind: "context", text: post.lines[postLine] ?? "" });
      postLine += 1;
    }
    blocks.push({ id: block.id, line: lines.length });
    const removedStart = lines.length;
    for (const text of block.originalLines) {
      lines.push({ kind: "removed", text, blockId: block.id });
    }
    const addedStart = lines.length;
    for (const text of block.postLines) {
      lines.push({ kind: "added", text, blockId: block.id });
    }
    const paired = Math.min(block.originalLines.length, block.postLines.length);
    for (let index = 0; index < paired; index += 1) {
      const before = block.originalLines[index] ?? "";
      const after = block.postLines[index] ?? "";
      const span = changedSpan(before, after);
      if (!span) {
        continue;
      }
      if (span.beforeEnd > span.beforeStart) {
        changedRanges.push({ kind: "removed", line: removedStart + index, start: span.beforeStart, end: span.beforeEnd });
      }
      if (span.afterEnd > span.afterStart) {
        changedRanges.push({ kind: "added", line: addedStart + index, start: span.afterStart, end: span.afterEnd });
      }
    }
    postLine = block.postStart + block.postLines.length;
  }
  while (postLine < post.lines.length) {
    lines.push({ kind: "context", text: post.lines[postLine] ?? "" });
    postLine += 1;
  }

  const eol = postContent.length > 0 ? post.eol : original.eol;
  const finalNewline = post.lines.length > 0 ? post.finalNewline : original.finalNewline;
  const content = lines.length === 0 ? "" : lines.map((line) => line.text).join(eol) + (finalNewline ? eol : "");
  return { content, lines, changedRanges, blocks };
}
