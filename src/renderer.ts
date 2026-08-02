import * as vscode from "vscode";
import { computeReviewBlocks } from "./diff";
import { createInlineReviewModel } from "./inlineReview";
import { isActiveStatus, ReviewStore, type ReviewFile } from "./reviewStore";
import { isInlineReviewDocument, reviewDocumentFileKey } from "./virtualDocuments";

export class ReviewRenderer implements vscode.Disposable {
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly inlineDeleted = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly insertedText = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
  });
  private readonly removedText = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
  });
  private readonly subscription: { dispose(): void };
  private readonly editorSubscription: vscode.Disposable;
  private readonly documentSubscription: vscode.Disposable;

  public constructor(private readonly store: ReviewStore) {
    this.subscription = store.subscribe(() => this.refresh());
    this.editorSubscription = vscode.window.onDidChangeVisibleTextEditors(() => this.refresh());
    this.documentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme === "codex-review") {
        this.refresh();
      }
    });
    this.refresh();
  }

  public refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const inline = isInlineReviewDocument(editor.document.uri);
      const virtualKey = inline ? reviewDocumentFileKey(editor.document.uri) : undefined;
      const file = virtualKey ? this.store.get(virtualKey) : this.store.findByUri(editor.document.uri);
      if (!file) {
        this.clear(editor);
        continue;
      }
      if (inline) {
        if (!isActiveStatus(file.status)) {
          this.clear(editor);
          continue;
        }
        const model = createInlineReviewModel(file.originalContent ?? "", file.postContent ?? "");
        editor.setDecorations(this.added, model.lines.flatMap((line, index) => line.kind === "added" ? [new vscode.Range(index, 0, index, 0)] : []));
        editor.setDecorations(this.inlineDeleted, model.lines.flatMap((line, index) => line.kind === "removed" ? [new vscode.Range(index, 0, index, 0)] : []));
        editor.setDecorations(this.insertedText, model.changedRanges.flatMap((range) => range.kind === "added"
          ? [new vscode.Range(range.line, range.start, range.line, range.end)]
          : []));
        editor.setDecorations(this.removedText, model.changedRanges.flatMap((range) => range.kind === "removed"
          ? [new vscode.Range(range.line, range.start, range.line, range.end)]
          : []));
        continue;
      }
      this.clear(editor);
    }
  }

  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.added, []);
    editor.setDecorations(this.inlineDeleted, []);
    editor.setDecorations(this.insertedText, []);
    editor.setDecorations(this.removedText, []);
  }

  public dispose(): void {
    this.subscription.dispose();
    this.editorSubscription.dispose();
    this.documentSubscription.dispose();
    this.added.dispose();
    this.inlineDeleted.dispose();
    this.insertedText.dispose();
    this.removedText.dispose();
  }
}

export class ReviewCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subscription: { dispose(): void };

  public constructor(private readonly store: ReviewStore) {
    this.subscription = store.subscribe(() => this.emitter.fire());
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const inline = isInlineReviewDocument(document.uri);
    if (!inline) {
      return [];
    }
    const virtualKey = inline ? reviewDocumentFileKey(document.uri) : undefined;
    const file = virtualKey ? this.store.get(virtualKey) : this.store.findByUri(document.uri);
    if (!file) {
      return [];
    }
    if (inline && !isActiveStatus(file.status)) {
      return [];
    }
    if (file.status === "pending" && file.kind !== "move") {
      const blocks = computeReviewBlocks(file.originalContent ?? "", file.postContent ?? "");
      if (blocks.length > 0) {
        const inlineLines = inline
          ? new Map(createInlineReviewModel(file.originalContent ?? "", file.postContent ?? "").blocks.map((block) => [block.id, block.line]))
          : undefined;
        const lastLine = Math.max(0, document.lineCount - 1);
        return blocks.flatMap((block) => {
          const line = Math.min(Math.max(0, inlineLines?.get(block.id) ?? block.postStart), lastLine);
          const range = new vscode.Range(line, 0, line, 0);
          const argument = { key: file.key, blockId: block.id };
          return [
            new vscode.CodeLens(range, { title: "$(check) Keep Change", command: "codexInlineReview.keepBlock", arguments: [argument] }),
            new vscode.CodeLens(range, { title: "$(discard) Undo Change", command: "codexInlineReview.undoBlock", arguments: [argument] }),
          ];
        });
      }
    }
    const lenses: vscode.CodeLens[] = [];
    const lastLine = Math.max(0, document.lineCount - 1);
    for (const blockLine of [file.markers.firstChangedLine]) {
      const line = Math.min(Math.max(0, blockLine), lastLine);
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(new vscode.CodeLens(range, { title: "$(check) Keep File", command: "codexInlineReview.keepFile", arguments: [file.key] }));
      if (file.status === "pending") {
        lenses.push(new vscode.CodeLens(range, { title: "$(discard) Undo File", command: "codexInlineReview.undoFile", arguments: [file.key] }));
      } else {
        lenses.push(new vscode.CodeLens(range, {
          title: `Undo unavailable (${file.status})`,
          command: "codexInlineReview.explainUndoUnavailable",
          arguments: [file.key],
        }));
      }
    }
    return lenses;
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
