import { promises as fs } from "node:fs";
import * as path from "node:path";

export function containsTraversal(candidate: string): boolean {
  return candidate.split(/[\\/]+/u).some((segment) => segment === "..");
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function isAbsoluteSafePath(candidate: string): boolean {
  return path.isAbsolute(candidate) && !containsTraversal(candidate) && !candidate.includes("\0");
}

export async function hasSafeExistingAncestor(rootLexical: string, rootReal: string, candidate: string): Promise<boolean> {
  let ancestor = path.dirname(path.resolve(candidate));
  while (isPathInside(rootLexical, ancestor)) {
    try {
      const realAncestor = path.resolve(await fs.realpath(ancestor));
      return isPathInside(rootReal, realAncestor);
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return false;
      }
      ancestor = parent;
    }
  }
  return false;
}
