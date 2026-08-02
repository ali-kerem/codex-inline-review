import * as vscode from "vscode";
import { computeReviewBlocks, resolveReviewBlock } from "./diff";
import { hashText } from "./hash";
import { ReviewStore, type ReviewFile, type ReviewFileAccess } from "./reviewStore";

interface ValidationFailure {
  file: ReviewFile;
  message: string;
}

export class UndoController {
  public constructor(
    private readonly store: ReviewStore,
    private readonly access: ReviewFileAccess,
    private readonly openDiff: (file: ReviewFile) => Promise<void>,
  ) {}

  public async undo(files: ReviewFile[]): Promise<boolean> {
    const unique = [...new Map(files.map((file) => [file.key, file])).values()];
    if (unique.length === 0) {
      return false;
    }
    const failures: ValidationFailure[] = [];
    for (const file of unique) {
      const failure = await this.validate(file);
      if (failure) {
        failures.push({ file, message: failure });
      }
    }
    if (failures.length > 0) {
      for (const failure of failures) {
        this.store.markConflicted(failure.file.key, failure.message);
      }
      const first = failures[0];
      const choice = await vscode.window.showWarningMessage(
        `Codex Review did not undo ${failures.length} file(s): ${first?.message ?? "validation failed"}`,
        "Open Diff",
      );
      if (choice === "Open Diff" && first) {
        await this.openDiff(first.file);
      }
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    for (const file of unique) {
      await this.addUndoEdit(edit, file);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      void vscode.window.showErrorMessage("Codex Review could not apply the validated undo batch.");
      return false;
    }
    if (!await this.saveUris(unique.flatMap((file) => [file.uri, ...(file.moveUri ? [file.moveUri] : [])]))) {
      void vscode.window.showErrorMessage("Codex Review changed the validated file buffer, but could not save it. Review state was not advanced.");
      return false;
    }
    this.store.markUndone(unique.map((file) => file.key));
    return true;
  }

  public async applySnapshotSide(files: ReviewFile[], side: "original" | "post"): Promise<boolean> {
    const unique = [...new Map(files.map((file) => [file.key, file])).values()];
    if (unique.length === 0) {
      return false;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const file of unique) {
      if (side === "original") {
        await this.addUndoEdit(edit, file);
      } else {
        await this.addPostEdit(edit, file);
      }
    }
    const applied = await vscode.workspace.applyEdit(edit);
    return applied && this.saveUris(unique.flatMap((file) => [file.uri, ...(file.moveUri ? [file.moveUri] : [])]));
  }

  public async applyText(uri: vscode.Uri, content: string | null): Promise<boolean> {
    const current = await this.access.readText(uri);
    if (current === content) {
      return true;
    }
    const edit = new vscode.WorkspaceEdit();
    if (content === null) {
      edit.deleteFile(uri, { ignoreIfNotExists: false, recursive: false });
    } else if (current === null) {
      edit.createFile(uri, { ignoreIfExists: false, overwrite: false });
      if (content.length > 0) {
        edit.insert(uri, new vscode.Position(0, 0), content);
      }
    } else {
      const document = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
      edit.replace(uri, fullRange, content);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    return applied && this.saveUris([uri]);
  }

  public async undoBlock(file: ReviewFile, blockId: string): Promise<boolean> {
    if (file.kind === "move") {
      void vscode.window.showWarningMessage("Move reviews can currently be resolved only as a whole file.");
      return false;
    }
    const failure = await this.validate(file);
    if (failure) {
      this.store.markConflicted(file.key, failure);
      const choice = await vscode.window.showWarningMessage(`Codex Review did not undo this change: ${failure}`, "Open Diff");
      if (choice === "Open Diff") {
        await this.openDiff(file);
      }
      return false;
    }
    const resolved = resolveReviewBlock(file.originalContent ?? "", file.postContent ?? "", blockId, "undo");
    if (!resolved) {
      void vscode.window.showWarningMessage("That review block is no longer current. Use the refreshed controls and try again.");
      return false;
    }

    const remaining = computeReviewBlocks(resolved.originalContent, resolved.postContent);
    const edit = new vscode.WorkspaceEdit();
    if (file.kind === "add" && file.originalContent === null && remaining.length === 0) {
      edit.deleteFile(file.uri, { ignoreIfNotExists: false, recursive: false });
    } else if (file.kind === "delete" && file.postContent === null) {
      edit.createFile(file.uri, { ignoreIfExists: false, overwrite: false });
      if (resolved.postContent.length > 0) {
        edit.insert(file.uri, new vscode.Position(0, 0), resolved.postContent);
      }
    } else {
      const document = await vscode.workspace.openTextDocument(file.uri);
      const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
      edit.replace(file.uri, fullRange, resolved.postContent);
    }
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      void vscode.window.showErrorMessage("Codex Review could not apply the validated change-block undo.");
      return false;
    }
    if (!await this.saveUris([file.uri])) {
      void vscode.window.showErrorMessage("Codex Review changed the validated file buffer, but could not save it. Review state was not advanced.");
      return false;
    }
    if (!this.store.resolveUndoneBlock(file.key, blockId)) {
      this.store.markConflicted(file.key, "The review state changed while its block undo was being applied.");
      void vscode.window.showErrorMessage("The file was updated, but the review state changed concurrently. Open the diff before continuing.");
      return false;
    }
    return true;
  }

  private async validate(file: ReviewFile): Promise<string | undefined> {
    if (file.status !== "pending") {
      return file.status === "reconstructionFailed"
        ? `Undo is unavailable because reconstruction failed: ${file.message ?? "unknown reason"}`
        : file.status === "conflicted"
          ? file.message ?? "The pending snapshot is conflicted."
          : "The file is no longer pending review.";
    }
    if (file.kind === "move") {
      if (!file.moveUri) {
        return "Move destination is missing from review state.";
      }
      const source = await this.access.readText(file.uri);
      const destination = await this.access.readText(file.moveUri);
      if (source !== null) {
        return "Move source was recreated after the Codex edit.";
      }
      if (destination === null || !file.postHash || hashText(destination) !== file.postHash) {
        return "Move destination changed after the Codex edit.";
      }
      return undefined;
    }
    const current = await this.access.readText(file.uri);
    if (file.kind === "delete") {
      return current === null ? undefined : "The deleted path was recreated after the Codex edit.";
    }
    if (current === null || !file.postHash || hashText(current) !== file.postHash) {
      return "The file changed after the Codex edit.";
    }
    return undefined;
  }

  private async addUndoEdit(edit: vscode.WorkspaceEdit, file: ReviewFile): Promise<void> {
    if (file.kind === "add") {
      edit.deleteFile(file.uri, { ignoreIfNotExists: false, recursive: false });
      return;
    }
    if (file.kind === "delete") {
      edit.createFile(file.uri, { ignoreIfExists: false, overwrite: false });
      if (file.originalContent) {
        edit.insert(file.uri, new vscode.Position(0, 0), file.originalContent);
      }
      return;
    }
    if (file.kind === "move") {
      if (!file.moveUri) {
        throw new Error("Move destination missing.");
      }
      edit.createFile(file.uri, { ignoreIfExists: false, overwrite: false });
      if (file.originalContent) {
        edit.insert(file.uri, new vscode.Position(0, 0), file.originalContent);
      }
      edit.deleteFile(file.moveUri, { ignoreIfNotExists: false, recursive: false });
      return;
    }
    const document = await vscode.workspace.openTextDocument(file.uri);
    const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
    edit.replace(file.uri, fullRange, file.originalContent ?? "");
  }

  private async addPostEdit(edit: vscode.WorkspaceEdit, file: ReviewFile): Promise<void> {
    if (file.kind === "add") {
      edit.createFile(file.uri, { ignoreIfExists: false, overwrite: false });
      if (file.postContent) {
        edit.insert(file.uri, new vscode.Position(0, 0), file.postContent);
      }
      return;
    }
    if (file.kind === "delete") {
      edit.deleteFile(file.uri, { ignoreIfNotExists: false, recursive: false });
      return;
    }
    if (file.kind === "move") {
      if (!file.moveUri) {
        throw new Error("Move destination missing.");
      }
      edit.createFile(file.moveUri, { ignoreIfExists: false, overwrite: false });
      if (file.postContent) {
        edit.insert(file.moveUri, new vscode.Position(0, 0), file.postContent);
      }
      edit.deleteFile(file.uri, { ignoreIfNotExists: false, recursive: false });
      return;
    }
    const document = await vscode.workspace.openTextDocument(file.uri);
    const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length));
    edit.replace(file.uri, fullRange, file.postContent ?? "");
  }

  private async saveUris(uris: vscode.Uri[]): Promise<boolean> {
    const unique = [...new Map(uris.map((uri) => [uri.toString(), uri])).values()];
    for (const uri of unique) {
      try {
        const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString())
          ?? await vscode.workspace.openTextDocument(uri);
        if (document.isDirty && !await document.save()) {
          return false;
        }
      } catch {
        // A successful delete intentionally leaves no document to save.
      }
    }
    return true;
  }
}
