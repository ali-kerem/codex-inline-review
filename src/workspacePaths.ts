import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { hasSafeExistingAncestor, isAbsoluteSafePath, isPathInside } from "./pathSafety";
import type { WorkspacePathResolver } from "./rolloutAdapter";

interface RootRecord {
  uri: vscode.Uri;
  lexicalPath: string;
  realPath: string;
}

export class WorkspacePathGuard implements WorkspacePathResolver {
  private constructor(private readonly roots: RootRecord[]) {}

  public static async create(): Promise<WorkspacePathGuard> {
    const roots: RootRecord[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const lexicalPath = path.resolve(folder.uri.fsPath);
      let realPath = lexicalPath;
      try {
        realPath = await fs.realpath(lexicalPath);
      } catch {
        // An unavailable workspace root cannot safely validate an external realpath.
      }
      roots.push({ uri: folder.uri, lexicalPath, realPath: path.resolve(realPath) });
    }
    return new WorkspacePathGuard(roots);
  }

  public async resolve(candidate: string, allowMissing: boolean): Promise<vscode.Uri | undefined> {
    if (!isAbsoluteSafePath(candidate)) {
      return undefined;
    }
    const lexical = path.resolve(candidate);
    const lexicalRoot = this.roots.find((root) => isPathInside(root.lexicalPath, lexical));
    if (!lexicalRoot) {
      return undefined;
    }
    if (!allowMissing) {
      try {
        const real = path.resolve(await fs.realpath(lexical));
        if (!isPathInside(lexicalRoot.realPath, real)) {
          return undefined;
        }
      } catch {
        return undefined;
      }
    } else {
      if (!await hasSafeExistingAncestor(lexicalRoot.lexicalPath, lexicalRoot.realPath, lexical)) {
        return undefined;
      }
    }
    const filePath = vscode.Uri.file(lexical).path;
    return lexicalRoot.uri.with({ path: filePath });
  }
}
