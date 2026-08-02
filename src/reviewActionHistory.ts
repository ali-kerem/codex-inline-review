import type * as vscode from "vscode";
import { hashText } from "./hash";
import { cloneReviewFile, type ReviewFile, type ReviewFileAccess } from "./reviewStore";

export type ReviewActionKind = "keep" | "undo";

export interface ReviewAction {
  id: number;
  kind: ReviewActionKind;
  snapshots: ReviewFile[];
}

type ReviewSide = "original" | "post";

function uriValues(file: ReviewFile): string[] {
  return [file.uri.toString(), ...(file.moveUri ? [file.moveUri.toString()] : [])];
}

function touchesUri(action: ReviewAction, uri: vscode.Uri): boolean {
  const value = uri.toString();
  return action.snapshots.some((file) => uriValues(file).includes(value));
}

async function contentMatches(access: ReviewFileAccess, uri: vscode.Uri, expectedHash: string | undefined, shouldExist: boolean): Promise<boolean> {
  const content = await access.readText(uri);
  if (!shouldExist) {
    return content === null;
  }
  return content !== null && expectedHash !== undefined && hashText(content) === expectedHash;
}

export async function snapshotMatchesSide(file: ReviewFile, side: ReviewSide, access: ReviewFileAccess): Promise<boolean> {
  if (side === "post") {
    if (file.kind === "move") {
      return file.moveUri !== undefined
        && await contentMatches(access, file.uri, undefined, false)
        && await contentMatches(access, file.moveUri, file.postHash, true);
    }
    if (file.kind === "delete") {
      return contentMatches(access, file.uri, undefined, false);
    }
    return contentMatches(access, file.uri, file.postHash, true);
  }

  if (file.kind === "move") {
    return file.moveUri !== undefined
      && await contentMatches(access, file.uri, file.originalHash, true)
      && await contentMatches(access, file.moveUri, undefined, false);
  }
  if (file.kind === "add") {
    return contentMatches(access, file.uri, undefined, false);
  }
  return contentMatches(access, file.uri, file.originalHash, true);
}

export async function actionMatchesSide(action: ReviewAction, side: ReviewSide, access: ReviewFileAccess): Promise<boolean> {
  for (const file of action.snapshots) {
    if (!await snapshotMatchesSide(file, side, access)) {
      return false;
    }
  }
  return true;
}

export class ReviewActionHistory {
  private readonly undoActions: ReviewAction[] = [];
  private readonly redoActions: ReviewAction[] = [];
  private nextId = 1;

  public record(kind: ReviewActionKind, snapshots: ReviewFile[]): ReviewAction | undefined {
    if (snapshots.length === 0) {
      return undefined;
    }
    const action: ReviewAction = {
      id: this.nextId,
      kind,
      snapshots: snapshots.map(cloneReviewFile),
    };
    this.nextId += 1;
    this.undoActions.push(action);
    this.redoActions.length = 0;
    return action;
  }

  public undoFor(uri: vscode.Uri): ReviewAction | undefined {
    return this.findLatest(this.undoActions, uri);
  }

  public redoFor(uri: vscode.Uri): ReviewAction | undefined {
    return this.findLatest(this.redoActions, uri);
  }

  public commitUndo(action: ReviewAction): void {
    if (this.remove(this.undoActions, action.id)) {
      this.redoActions.push(action);
    }
  }

  public commitRedo(action: ReviewAction): void {
    if (this.remove(this.redoActions, action.id)) {
      this.undoActions.push(action);
    }
  }

  public invalidateUris(uris: vscode.Uri[]): void {
    const values = new Set(uris.map((uri) => uri.toString()));
    const keep = (action: ReviewAction): boolean => !action.snapshots.some((file) => uriValues(file).some((value) => values.has(value)));
    this.filterInPlace(this.undoActions, keep);
    this.filterInPlace(this.redoActions, keep);
  }

  public clear(): void {
    this.undoActions.length = 0;
    this.redoActions.length = 0;
  }

  private findLatest(actions: ReviewAction[], uri: vscode.Uri): ReviewAction | undefined {
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      const action = actions[index];
      if (action && touchesUri(action, uri)) {
        return action;
      }
    }
    return undefined;
  }

  private remove(actions: ReviewAction[], id: number): boolean {
    const index = actions.findIndex((action) => action.id === id);
    if (index < 0) {
      return false;
    }
    actions.splice(index, 1);
    return true;
  }

  private filterInPlace(actions: ReviewAction[], predicate: (action: ReviewAction) => boolean): void {
    const retained = actions.filter(predicate);
    actions.splice(0, actions.length, ...retained);
  }
}
