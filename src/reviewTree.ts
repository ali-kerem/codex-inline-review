import * as vscode from "vscode";
import {
  hasAcceptedChanges,
  hasPendingReviewBlocks,
  reviewCategory,
  ReviewStore,
  type ReviewCategory,
  type ReviewFile,
  type ReviewTurn,
} from "./reviewStore";
import { turnDisplayLabel } from "./turnDisplay";

type TreeNode =
  | { type: "turn"; turn: ReviewTurn }
  | { type: "section"; turn: ReviewTurn; category: ReviewCategory }
  | { type: "file"; file: ReviewFile; turn: ReviewTurn; category: ReviewCategory };

const CATEGORIES: ReviewCategory[] = ["pending", "accepted", "partiallyAccepted", "discarded"];

const CATEGORY_LABEL: Record<ReviewCategory, string> = {
  pending: "Pending",
  accepted: "Accepted",
  partiallyAccepted: "Partially Accepted",
  discarded: "Discarded",
};

const CATEGORY_ICON: Record<ReviewCategory, string> = {
  pending: "diff",
  accepted: "check-all",
  partiallyAccepted: "diff-multiple",
  discarded: "discard",
};

export class ReviewTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: { dispose(): void };

  public constructor(private readonly store: ReviewStore) {
    this.subscription = store.subscribe(() => this.emitter.fire());
  }

  public getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.store.allTurns().map((turn) => ({ type: "turn", turn }));
    }
    if (element.type === "file") {
      return [];
    }
    if (element.type === "turn") {
      return CATEGORIES.map((category) => ({ type: "section", turn: element.turn, category }));
    }
    return this.filesForTurn(element.turn, element.category)
      .map((file) => ({ type: "file", file, turn: element.turn, category: element.category }));
  }

  private filesForTurn(turn: ReviewTurn, category: ReviewCategory): ReviewFile[] {
    return turn.fileKeys
      .map((key) => this.store.get(key))
      .filter((file): file is ReviewFile => file !== undefined)
      .filter((file) => reviewCategory(file) === category);
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.type === "turn") {
      const files = element.turn.fileKeys.flatMap((key) => this.store.get(key) ? [this.store.get(key)!] : []);
      const archived = this.store.isArchivedTurn(element.turn.turnId);
      const item = new vscode.TreeItem(
        turnDisplayLabel(element.turn.turnId, element.turn.timestamp),
        archived ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `turn:${archived ? "archived" : "active"}:${element.turn.turnId}`;
      item.description = `${archived ? "archived" : "active"} · ${files.length} ${files.length === 1 ? "file" : "files"}`;
      item.tooltip = `Codex turn ${element.turn.turnId}\n${element.turn.timestamp}\n${archived ? "Read-only archive" : "Active review turn"}`;
      item.iconPath = new vscode.ThemeIcon(archived ? "archive" : "history");
      item.contextValue = `codexReview.turn.${archived ? "archived" : "active"}`;
      return item;
    }
    if (element.type === "section") {
      const files = this.filesForTurn(element.turn, element.category);
      const item = new vscode.TreeItem(
        CATEGORY_LABEL[element.category],
        element.category === "pending" || element.category === "partiallyAccepted"
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `section:${element.turn.turnId}:${element.category}`;
      item.description = String(files.length);
      item.contextValue = `codexReview.section.${element.category}`;
      item.iconPath = new vscode.ThemeIcon(CATEGORY_ICON[element.category]);
      return item;
    }
    const file = element.file;
    const displayUri = file.moveUri ?? file.uri;
    const label = displayUri.path.split("/").at(-1) ?? displayUri.path;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = file.status === "reconstructionFailed" || file.status === "conflicted"
      ? `${file.kind} · ${file.status === "reconstructionFailed" ? "reconstruction failed" : "conflicted"}`
      : file.kind;
    item.resourceUri = displayUri;
    item.tooltip = file.message ? `${displayUri.fsPath}\n${file.message}` : displayUri.fsPath;
    const hasPending = hasPendingReviewBlocks(file);
    const archived = this.store.isArchivedTurn(element.turn.turnId);
    const acceptedSubset = hasAcceptedChanges(file);
    item.contextValue = `codexReview.file.${archived ? "archived" : "active"}.${element.category}.${acceptedSubset ? "acceptedSubset" : "noAcceptedSubset"}`;
    item.iconPath = new vscode.ThemeIcon(
      file.status === "reconstructionFailed" || file.status === "conflicted" ? "warning" : CATEGORY_ICON[element.category],
      file.status === "conflicted" || file.status === "reconstructionFailed" ? new vscode.ThemeColor("problemsWarningIcon.foreground") : undefined,
    );
    item.command = {
      command: !archived && element.category === "pending" && hasPending
        ? "codexInlineReview.openInlineReview"
        : element.category === "partiallyAccepted"
          ? "codexInlineReview.openAcceptedDiff"
        : "codexInlineReview.openDiff",
      title: "Open change",
      arguments: [file.key],
    };
    return item;
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

export class ReviewStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  private readonly subscription: { dispose(): void };

  public constructor(private readonly store: ReviewStore) {
    this.item.command = "codexInlineReview.showPendingChanges";
    this.item.tooltip = "Show Codex pending file reviews";
    this.subscription = store.subscribe(() => this.refresh());
    this.refresh();
    this.item.show();
  }

  private refresh(): void {
    const count = this.store.activeFiles().length;
    this.item.text = `$(diff) Codex Review: ${count} ${count === 1 ? "file" : "files"}`;
  }

  public dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
