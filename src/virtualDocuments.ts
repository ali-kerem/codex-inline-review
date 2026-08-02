import * as vscode from "vscode";
import { createInlineReviewModel } from "./inlineReview";
import {
  fullOriginalContent,
  fullPostContent,
  hasAcceptedChanges,
  isActiveStatus,
  ReviewStore,
  type ReviewFile,
} from "./reviewStore";
import { turnDisplayLabel } from "./turnDisplay";

export const REVIEW_DOCUMENT_SCHEME = "codex-review";
type ReviewDocumentSide = "original" | "post" | "fullOriginal" | "fullPost" | "accepted" | "inline";

export function reviewDocumentFileKey(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== REVIEW_DOCUMENT_SCHEME) {
    return undefined;
  }
  return new URLSearchParams(uri.query).get("key") ?? undefined;
}

export function isInlineReviewDocument(uri: vscode.Uri): boolean {
  return uri.scheme === REVIEW_DOCUMENT_SCHEME && new URLSearchParams(uri.query).get("side") === "inline";
}

export class ReviewDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.emitter.event;
  private readonly subscription: { dispose(): void };

  public constructor(private readonly store: ReviewStore) {
    this.subscription = store.subscribe(() => {
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme === REVIEW_DOCUMENT_SCHEME) {
          this.emitter.fire(document.uri);
        }
      }
    });
  }

  public uri(file: ReviewFile, side: ReviewDocumentSide): vscode.Uri {
    const fileName = file.uri.path.split("/").at(-1) ?? "file";
    const turnId = file.turnIds.at(-1) ?? "unknown";
    const displayName = side === "inline" ? `${fileName} (${turnDisplayLabel(turnId, file.timestamp)})` : fileName;
    return vscode.Uri.from({
      scheme: REVIEW_DOCUMENT_SCHEME,
      path: `/${side}/${displayName}`,
      query: `key=${encodeURIComponent(file.key)}&side=${side}`,
    });
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const file = this.store.get(params.get("key") ?? "");
    if (!file) {
      return "";
    }
    if (params.get("side") === "inline") {
      if (!isActiveStatus(file.status)) {
        return file.status === "undone" ? file.originalContent ?? "" : file.postContent ?? "";
      }
      return createInlineReviewModel(file.originalContent ?? "", file.postContent ?? "").content;
    }
    switch (params.get("side")) {
      case "post":
        return file.postContent ?? "";
      case "fullOriginal":
        return fullOriginalContent(file) ?? "";
      case "fullPost":
        return fullPostContent(file) ?? "";
      case "accepted":
        return file.originalContent ?? "";
      default:
        return file.originalContent ?? "";
    }
  }

  public async openInline(file: ReviewFile, viewColumn?: vscode.ViewColumn, preserveFocus = false): Promise<vscode.TextEditor | undefined> {
    if (file.turnIds.some((turnId) => this.store.isArchivedTurn(turnId))) {
      await vscode.window.showInformationMessage("Older Codex turns are read-only archives. Open their full or accepted diff from the sidebar.");
      return undefined;
    }
    let document = await vscode.workspace.openTextDocument(this.uri(file, "inline"));
    const currentUri = file.moveUri ?? file.uri;
    try {
      const currentDocument = await vscode.workspace.openTextDocument(currentUri);
      if (document.languageId !== currentDocument.languageId) {
        document = await vscode.languages.setTextDocumentLanguage(document, currentDocument.languageId);
      }
    } catch {
      // Deleted paths still get best-effort language detection from the virtual URI suffix.
    }
    return vscode.window.showTextDocument(document, { viewColumn, preserveFocus, preview: true });
  }

  public async openDiff(file: ReviewFile): Promise<void> {
    if (file.status === "reconstructionFailed") {
      await vscode.window.showWarningMessage(`Original content is unavailable, so a full diff cannot be opened: ${file.message ?? "reconstruction failed"}`);
      return;
    }
    const left = this.uri(file, "fullOriginal");
    const right = this.uri(file, "fullPost");
    const name = file.moveUri?.path.split("/").at(-1) ?? file.uri.path.split("/").at(-1) ?? "file";
    await vscode.commands.executeCommand("vscode.diff", left, right, `${name} (Full Codex Diff)`, { preview: true });
  }

  public async openAcceptedDiff(file: ReviewFile): Promise<void> {
    if (file.status === "reconstructionFailed") {
      await vscode.window.showWarningMessage(`Original content is unavailable, so the accepted diff cannot be opened: ${file.message ?? "reconstruction failed"}`);
      return;
    }
    if (!hasAcceptedChanges(file)) {
      await vscode.window.showInformationMessage("This file does not currently contain accepted Codex change blocks.");
      return;
    }
    const left = this.uri(file, "fullOriginal");
    const right = this.uri(file, "accepted");
    const name = file.moveUri?.path.split("/").at(-1) ?? file.uri.path.split("/").at(-1) ?? "file";
    await vscode.commands.executeCommand("vscode.diff", left, right, `${name} (Accepted Changes Only)`, { preview: true });
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export function registerReviewDocumentProvider(provider: ReviewDocumentProvider): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(REVIEW_DOCUMENT_SCHEME, provider);
}
