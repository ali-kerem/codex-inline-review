import * as vscode from "vscode";
import { readCurrentText } from "./currentText";
import type { ReviewFileAccess } from "./reviewStore";

export class WorkspaceFileAccess implements ReviewFileAccess {
  public async readText(uri: vscode.Uri): Promise<string | null> {
    try {
      await vscode.workspace.fs.stat(uri);
      return readCurrentText(uri, vscode.workspace.textDocuments, async () => {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      });
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
}

function isNotFound(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }
  const code = (error as { code?: unknown })?.code;
  return code === "ENOENT" || code === "FileNotFound";
}
