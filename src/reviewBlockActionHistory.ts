import type * as vscode from "vscode";
import { cloneReviewFile, type ReviewFile, type ReviewFileAccess } from "./reviewStore";

export interface ReviewBlockAction {
  id: number;
  kind: "keep" | "undo";
  beforeReview: ReviewFile;
  afterReview: ReviewFile;
  beforeText: string | null;
  afterText: string | null;
}

function uriValues(action: ReviewBlockAction): string[] {
  const file = action.beforeReview;
  return [file.uri.toString(), ...(file.moveUri ? [file.moveUri.toString()] : [])];
}

function reviewStatesEqual(current: ReviewFile | undefined, expected: ReviewFile): boolean {
  return current !== undefined
    && current.key === expected.key
    && current.kind === expected.kind
    && current.status === expected.status
    && current.uri.toString() === expected.uri.toString()
    && current.moveUri?.toString() === expected.moveUri?.toString()
    && current.originalContent === expected.originalContent
    && current.postContent === expected.postContent
    && current.originalHash === expected.originalHash
    && current.postHash === expected.postHash;
}

export async function blockActionMatchesState(
  action: ReviewBlockAction,
  state: "before" | "after",
  currentReview: ReviewFile | undefined,
  access: ReviewFileAccess,
): Promise<boolean> {
  const expectedReview = state === "before" ? action.beforeReview : action.afterReview;
  const expectedText = state === "before" ? action.beforeText : action.afterText;
  return reviewStatesEqual(currentReview, expectedReview)
    && await access.readText(action.beforeReview.uri) === expectedText;
}

export class ReviewBlockActionHistory {
  private readonly undoActions: ReviewBlockAction[] = [];
  private readonly redoActions: ReviewBlockAction[] = [];
  private nextId = 1;

  public record(
    kind: ReviewBlockAction["kind"],
    beforeReview: ReviewFile,
    afterReview: ReviewFile,
    beforeText: string | null,
    afterText: string | null,
  ): ReviewBlockAction {
    const action: ReviewBlockAction = {
      id: this.nextId,
      kind,
      beforeReview: cloneReviewFile(beforeReview),
      afterReview: cloneReviewFile(afterReview),
      beforeText,
      afterText,
    };
    this.nextId += 1;
    this.undoActions.push(action);
    this.redoActions.length = 0;
    return action;
  }

  public undoFor(uri: vscode.Uri): ReviewBlockAction | undefined {
    return this.findLatest(this.undoActions, uri);
  }

  public redoFor(uri: vscode.Uri): ReviewBlockAction | undefined {
    return this.findLatest(this.redoActions, uri);
  }

  public commitUndo(action: ReviewBlockAction): void {
    if (this.remove(this.undoActions, action.id)) {
      this.redoActions.push(action);
    }
  }

  public commitRedo(action: ReviewBlockAction): void {
    if (this.remove(this.redoActions, action.id)) {
      this.undoActions.push(action);
    }
  }

  public invalidateUris(uris: vscode.Uri[]): void {
    const values = new Set(uris.map((uri) => uri.toString()));
    const keep = (action: ReviewBlockAction): boolean => !uriValues(action).some((value) => values.has(value));
    this.filterInPlace(this.undoActions, keep);
    this.filterInPlace(this.redoActions, keep);
  }

  public clear(): void {
    this.undoActions.length = 0;
    this.redoActions.length = 0;
  }

  private findLatest(actions: ReviewBlockAction[], uri: vscode.Uri): ReviewBlockAction | undefined {
    const value = uri.toString();
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      const action = actions[index];
      if (action && uriValues(action).includes(value)) {
        return action;
      }
    }
    return undefined;
  }

  private remove(actions: ReviewBlockAction[], id: number): boolean {
    const index = actions.findIndex((action) => action.id === id);
    if (index < 0) {
      return false;
    }
    actions.splice(index, 1);
    return true;
  }

  private filterInPlace(actions: ReviewBlockAction[], predicate: (action: ReviewBlockAction) => boolean): void {
    const retained = actions.filter(predicate);
    actions.splice(0, actions.length, ...retained);
  }
}
