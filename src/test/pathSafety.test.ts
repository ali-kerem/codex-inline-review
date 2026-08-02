import * as assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { containsTraversal, hasSafeExistingAncestor, isAbsoluteSafePath, isPathInside } from "../pathSafety";

test("contains only files within a workspace root", () => {
  const root = path.resolve("/workspace/project");
  assert.equal(isPathInside(root, path.join(root, "src", "file.ts")), true);
  assert.equal(isPathInside(root, path.resolve("/workspace/project-other/file.ts")), false);
});

test("rejects traversal and relative paths", () => {
  assert.equal(containsTraversal("/workspace/project/../secret"), true);
  assert.equal(isAbsoluteSafePath("relative/file.ts"), false);
  assert.equal(isAbsoluteSafePath("/workspace/project/../secret"), false);
});

test("missing files cannot escape through an external symlink ancestor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-review-paths-"));
  const root = path.join(directory, "workspace");
  const outside = path.join(directory, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, path.join(root, "link"));
  const rootReal = await realpath(root);
  assert.equal(await hasSafeExistingAncestor(root, rootReal, path.join(root, "new", "file.txt")), true);
  assert.equal(await hasSafeExistingAncestor(root, rootReal, path.join(root, "link", "file.txt")), false);
});
