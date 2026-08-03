import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ReviewCodeLensProvider, ReviewRenderer } from "./renderer";
import { actionMatchesSide, ReviewActionHistory, snapshotMatchesSide } from "./reviewActionHistory";
import { blockActionMatchesState, ReviewBlockActionHistory } from "./reviewBlockActionHistory";
import { interceptPendingReviewUndo } from "./pendingReviewUndo";
import {
  hasPendingReviewBlocks,
  reviewCategory,
  ReviewStore,
  type ReviewFile,
  type StoredReviewDecision,
} from "./reviewStore";
import { ReviewStatusBar, ReviewTreeProvider } from "./reviewTree";
import { RolloutEventAdapter } from "./rolloutAdapter";
import { normalizeSessionId } from "./rolloutDiscovery";
import { RolloutEventSource, type CheckpointStorage } from "./rolloutSource";
import { UndoController } from "./undoController";
import {
  isInlineReviewDocument,
  registerReviewDocumentProvider,
  REVIEW_DOCUMENT_SCHEME,
  reviewDocumentFileKey,
  ReviewDocumentProvider,
} from "./virtualDocuments";
import { WorkspaceFileAccess } from "./vscodeFiles";
import { WorkspacePathGuard } from "./workspacePaths";

const CHECKPOINT_KEY = "codexInlineReview.rolloutCheckpoints.v1";
const PINNED_SESSION_KEY = "codexInlineReview.pinnedSessions.v1";
const REVIEW_DECISIONS_KEY = "codexInlineReview.reviewDecisions.v1";

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("codexInlineReview");
}

function resolveCodexHome(): string {
  const configured = configuration().get<string>("codexHome", "").trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("codexInlineReview.codexHome must be an absolute path.");
    }
    return path.normalize(configured);
  }
  const environment = process.env.CODEX_HOME?.trim();
  if (environment) {
    if (!path.isAbsolute(environment)) {
      throw new Error("CODEX_HOME must be an absolute path.");
    }
    return path.normalize(environment);
  }
  return path.join(os.homedir(), ".codex");
}

class WorkspaceCheckpointStorage implements CheckpointStorage {
  public constructor(private readonly state: vscode.Memento, private readonly codexHome: string) {}

  public load(): Record<string, { identity: string; offset: number }> {
    const all = this.state.get<Record<string, Record<string, { identity: string; offset: number }>>>(CHECKPOINT_KEY, {});
    return all[this.codexHome] ?? {};
  }

  public async save(checkpoints: Record<string, { identity: string; offset: number }>): Promise<void> {
    const all = this.state.get<Record<string, Record<string, { identity: string; offset: number }>>>(CHECKPOINT_KEY, {});
    await this.state.update(CHECKPOINT_KEY, { ...all, [this.codexHome]: checkpoints });
  }
}

function pinnedSessionId(state: vscode.Memento, codexHome: string): string | undefined {
  return state.get<Record<string, string>>(PINNED_SESSION_KEY, {})[codexHome];
}

async function savePinnedSessionId(state: vscode.Memento, codexHome: string, sessionId?: string): Promise<void> {
  const all = state.get<Record<string, string>>(PINNED_SESSION_KEY, {});
  const updated = { ...all };
  if (sessionId) {
    updated[codexHome] = sessionId;
  } else {
    delete updated[codexHome];
  }
  await state.update(PINNED_SESSION_KEY, updated);
}

type StoredSessionDecisions = Record<string, StoredReviewDecision>;
type StoredHomeDecisions = Record<string, Record<string, StoredSessionDecisions>>;

function reviewDecisions(
  state: vscode.Memento,
  codexHome: string,
  sessionId: string,
): StoredSessionDecisions {
  const candidate = state.get<StoredHomeDecisions>(REVIEW_DECISIONS_KEY, {})[codexHome]?.[sessionId];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {};
  }
  const validated: StoredSessionDecisions = {};
  for (const [fileKey, rawDecision] of Object.entries(candidate)) {
    if (!rawDecision || typeof rawDecision !== "object" || Array.isArray(rawDecision)
      || !("blockDecisions" in rawDecision)
      || typeof rawDecision.blockDecisions !== "object"
      || rawDecision.blockDecisions === null
      || Array.isArray(rawDecision.blockDecisions)) {
      continue;
    }
    const blockDecisions = Object.fromEntries(
      Object.entries(rawDecision.blockDecisions)
        .filter((entry): entry is [string, "keep" | "undo"] => entry[1] === "keep" || entry[1] === "undo"),
    );
    if (Object.keys(blockDecisions).length > 0) {
      validated[fileKey] = { blockDecisions };
    }
  }
  return validated;
}

async function saveReviewDecisions(
  state: vscode.Memento,
  codexHome: string,
  sessionId: string,
  decisions: StoredSessionDecisions,
): Promise<void> {
  const all = state.get<StoredHomeDecisions>(REVIEW_DECISIONS_KEY, {});
  const sessions = all[codexHome] ?? {};
  await state.update(REVIEW_DECISIONS_KEY, {
    ...all,
    [codexHome]: { ...sessions, [sessionId]: decisions },
  });
}

function extensionHostKind(context: vscode.ExtensionContext): string {
  const kind = context.extension.extensionKind === vscode.ExtensionKind.Workspace ? "workspace" : "UI";
  return vscode.env.remoteName ? `${kind} (remote)` : `${kind} (local)`;
}

async function closeArchivedInlineReviewTabs(store: ReviewStore, turnId?: string): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
    if (!(tab.input instanceof vscode.TabInputText) || !isInlineReviewDocument(tab.input.uri)) {
      return false;
    }
    const key = reviewDocumentFileKey(tab.input.uri);
    const file = key === undefined ? undefined : store.get(key);
    if (!file) {
      return true;
    }
    return turnId
      ? file.turnIds.includes(turnId)
      : file.turnIds.some((candidate) => store.isArchivedTurn(candidate));
  });
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Codex Inline Review", { log: true });
  context.subscriptions.push(output);

  let codexHome: string;
  try {
    codexHome = resolveCodexHome();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.error(message);
    void vscode.window.showErrorMessage(`Codex Inline Review: ${message}`);
    return;
  }

  const fileAccess = new WorkspaceFileAccess();
  const store = new ReviewStore(fileAccess);
  let activePinnedSessionId: string | undefined;
  let decisionSave = Promise.resolve();
  const decisionSubscription = store.subscribe(() => {
    const sessionId = activePinnedSessionId;
    if (!sessionId) {
      return;
    }
    const decisions = store.storedReviewDecisions();
    decisionSave = decisionSave
      .then(() => saveReviewDecisions(context.workspaceState, codexHome, sessionId, decisions))
      .catch((error: unknown) => {
        output.error(`Could not persist content-free review decisions: ${error instanceof Error ? error.message : String(error)}`);
      });
  });
  const actionHistory = new ReviewActionHistory();
  const blockActionHistory = new ReviewBlockActionHistory();
  const virtualDocuments = new ReviewDocumentProvider(store);
  const renderer = new ReviewRenderer(store);
  const codeLens = new ReviewCodeLensProvider(store);
  const tree = new ReviewTreeProvider(store);
  const status = new ReviewStatusBar(store);
  context.subscriptions.push(
    { dispose: () => { activePinnedSessionId = undefined; decisionSubscription.dispose(); actionHistory.clear(); blockActionHistory.clear(); store.clear(); } },
    virtualDocuments,
    registerReviewDocumentProvider(virtualDocuments),
    renderer,
    codeLens,
    tree,
    status,
    vscode.languages.registerCodeLensProvider({ scheme: REVIEW_DOCUMENT_SCHEME }, codeLens),
    vscode.window.registerTreeDataProvider("codexInlineReview.pendingChanges", tree),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      void closeArchivedInlineReviewTabs(store);
    }),
  );
  void closeArchivedInlineReviewTabs(store);

  const pathGuard = await WorkspacePathGuard.create();
  const adapter = new RolloutEventAdapter(pathGuard);
  const configuredPollInterval = configuration().get<number>("pollIntervalMs", 750);
  const pollInterval = Number.isFinite(configuredPollInterval) ? Math.max(250, configuredPollInterval) : 750;
  const source = new RolloutEventSource(
    codexHome,
    pollInterval,
    adapter,
    new WorkspaceCheckpointStorage(context.workspaceState, codexHome),
    output,
  );
  context.subscriptions.push(source, source.onDidChangeBatch((batch) => {
    const previousTurnId = store.currentTurnId();
    const activatesNewTurn = store.willActivateTurn(batch.turnId, batch.timestamp) && previousTurnId !== batch.turnId;
    if (activatesNewTurn) {
      actionHistory.clear();
      blockActionHistory.clear();
    }
    const changedUris = batch.changes.flatMap((change) => [change.uri, ...(change.moveUri ? [change.moveUri] : [])]);
    actionHistory.invalidateUris(changedUris);
    blockActionHistory.invalidateUris(changedUris);
    void (async () => {
      await store.ingest(batch);
      if (activatesNewTurn && previousTurnId) {
        await closeArchivedInlineReviewTabs(store, previousTurnId);
      }
    })().catch((error: unknown) => {
      output.error(`Could not create or present review state for a normalized change batch: ${error instanceof Error ? error.message : String(error)}`);
    });
  }));

  const loadPinnedSession = async (sessionId: string): Promise<{ filePath: string; turnCount: number }> => {
    await decisionSave;
    const previousSessionId = activePinnedSessionId;
    activePinnedSessionId = undefined;
    try {
      const history = await source.watchSessionById(sessionId);
      actionHistory.clear();
      blockActionHistory.clear();
      await store.ingestSessionHistory(
        history.batches,
        reviewDecisions(context.workspaceState, codexHome, sessionId),
      );
      activePinnedSessionId = sessionId;
      await saveReviewDecisions(context.workspaceState, codexHome, sessionId, store.storedReviewDecisions());
      await closeArchivedInlineReviewTabs(store);
      return { filePath: history.filePath, turnCount: store.allTurns().length };
    } catch (error) {
      activePinnedSessionId = previousSessionId;
      throw error;
    }
  };

  const openDiff = async (file: ReviewFile): Promise<void> => virtualDocuments.openDiff(file);
  const openAcceptedDiff = async (file: ReviewFile): Promise<void> => virtualDocuments.openAcceptedDiff(file);
  const undo = new UndoController(store, fileAccess, openDiff);

  const runDefaultEditorCommand = async (command: "undo" | "redo"): Promise<void> => {
    await vscode.commands.executeCommand(command);
  };

  const smartUndo = async (): Promise<void> => {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri || !isInlineReviewDocument(activeUri)) {
      await runDefaultEditorCommand("undo");
      return;
    }
    const virtualFile = reviewDocumentFileKey(activeUri);
    const reviewFile = virtualFile ? store.get(virtualFile) : store.findByUri(activeUri);
    const historyUri = reviewFile?.moveUri ?? reviewFile?.uri ?? activeUri;
    const blockAction = blockActionHistory.undoFor(historyUri);
    if (blockAction) {
      const currentReview = store.get(blockAction.afterReview.key);
      if (await blockActionMatchesState(blockAction, "after", currentReview, fileAccess)) {
        if (!await undo.applyText(blockAction.beforeReview.uri, blockAction.beforeText)
          || await fileAccess.readText(blockAction.beforeReview.uri) !== blockAction.beforeText) {
          output.warn("The previous block content could not be restored; review state was left unchanged.");
          return;
        }
        store.restoreSnapshots([blockAction.beforeReview]);
        blockActionHistory.commitUndo(blockAction);
        return;
      }
      blockActionHistory.invalidateUris([historyUri]);
    }
    if (await interceptPendingReviewUndo(reviewFile, {
      snapshots: (file) => store.snapshots([file.key]),
      apply: (file) => undo.undo([file]),
      record: (snapshots) => {
        blockActionHistory.invalidateUris(snapshots.flatMap((file) => [file.uri, ...(file.moveUri ? [file.moveUri] : [])]));
        actionHistory.record("undo", snapshots);
      },
    })) {
      return;
    }
    const action = actionHistory.undoFor(historyUri);
    const expectedSide = action?.kind === "undo" ? "original" : "post";
    if (!action || !await actionMatchesSide(action, expectedSide, fileAccess)) {
      await runDefaultEditorCommand("undo");
      return;
    }
    if (action.kind === "undo") {
      if (!await undo.applySnapshotSide(action.snapshots, "post") || !await actionMatchesSide(action, "post", fileAccess)) {
        output.warn("The Codex post-edit snapshot could not be restored; review state was left unchanged.");
        return;
      }
    }
    store.restoreSnapshots(action.snapshots);
    actionHistory.commitUndo(action);
  };

  const smartRedo = async (): Promise<void> => {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri || !isInlineReviewDocument(activeUri)) {
      await runDefaultEditorCommand("redo");
      return;
    }
    const virtualFile = reviewDocumentFileKey(activeUri);
    const reviewFile = virtualFile ? store.get(virtualFile) : store.findByUri(activeUri);
    const historyUri = reviewFile?.moveUri ?? reviewFile?.uri ?? activeUri;
    const blockAction = blockActionHistory.redoFor(historyUri);
    if (blockAction) {
      const currentReview = store.get(blockAction.beforeReview.key);
      if (await blockActionMatchesState(blockAction, "before", currentReview, fileAccess)) {
        if (!await undo.applyText(blockAction.afterReview.uri, blockAction.afterText)
          || await fileAccess.readText(blockAction.afterReview.uri) !== blockAction.afterText) {
          output.warn("The resolved block content could not be restored; review state was left unchanged.");
          return;
        }
        store.restoreSnapshots([blockAction.afterReview]);
        blockActionHistory.commitRedo(blockAction);
        return;
      }
      blockActionHistory.invalidateUris([historyUri]);
    }
    const action = actionHistory.redoFor(historyUri);
    if (!action) {
      if (!actionHistory.undoFor(historyUri)) {
        await runDefaultEditorCommand("redo");
      }
      return;
    }
    if (!await actionMatchesSide(action, "post", fileAccess)) {
      await runDefaultEditorCommand("redo");
      return;
    }
    if (action.kind === "undo") {
      if (!await undo.applySnapshotSide(action.snapshots, "original") || !await actionMatchesSide(action, "original", fileAccess)) {
        output.warn("The pre-Codex snapshot could not be restored; review state was left unchanged.");
        return;
      }
    }
    store.setStatuses(action.snapshots.map((file) => file.key), action.kind === "keep" ? "kept" : "undone");
    actionHistory.commitRedo(action);
  };

  const resolveFile = (argument?: unknown): ReviewFile | undefined => {
    if (typeof argument === "string") {
      return store.get(argument);
    }
    if (typeof argument === "object" && argument !== null && "key" in argument && typeof (argument as { key?: unknown }).key === "string") {
      return store.get((argument as { key: string }).key);
    }
    if (typeof argument === "object" && argument !== null && "file" in argument) {
      const file = (argument as { file?: unknown }).file;
      if (typeof file === "object" && file !== null && "key" in file && typeof (file as { key?: unknown }).key === "string") {
        return store.get((file as { key: string }).key);
      }
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (!activeUri) {
      return undefined;
    }
    const virtualKey = reviewDocumentFileKey(activeUri);
    return virtualKey ? store.get(virtualKey) : store.findByUri(activeUri);
  };

  const resolveBlock = (argument?: unknown): { file: ReviewFile; blockId: string } | undefined => {
    if (typeof argument !== "object" || argument === null) {
      return undefined;
    }
    const candidate = argument as { key?: unknown; blockId?: unknown };
    if (typeof candidate.key !== "string" || typeof candidate.blockId !== "string") {
      return undefined;
    }
    const file = store.get(candidate.key);
    return file && file.turnIds.includes(store.currentTurnId() ?? "") ? { file, blockId: candidate.blockId } : undefined;
  };

  const invalidateFileActionHistory = (file: ReviewFile): void => {
    actionHistory.invalidateUris([file.uri, ...(file.moveUri ? [file.moveUri] : [])]);
  };

  const invalidateBlockHistory = (files: ReviewFile[]): void => {
    blockActionHistory.invalidateUris(files.flatMap((file) => [file.uri, ...(file.moveUri ? [file.moveUri] : [])]));
  };

  const resolveTurnId = (argument?: unknown): string | undefined => {
    if (typeof argument !== "object" || argument === null || !("turn" in argument)) {
      return undefined;
    }
    const turn = (argument as { turn?: unknown }).turn;
    if (typeof turn !== "object" || turn === null || !("turnId" in turn)) {
      return undefined;
    }
    return typeof (turn as { turnId?: unknown }).turnId === "string" ? (turn as { turnId: string }).turnId : undefined;
  };

  const filesForTurn = (turnId: string): ReviewFile[] => {
    const turn = store.allTurns().find((candidate) => candidate.turnId === turnId);
    return turn
      ? [...new Map(turn.fileKeys.flatMap((key) => {
        const file = store.get(key);
        return file ? [[file.key, file] as const] : [];
      })).values()]
      : [];
  };

  const invalidateAllActionHistory = (files: ReviewFile[]): void => {
    for (const file of files) {
      invalidateFileActionHistory(file);
    }
    invalidateBlockHistory(files);
  };

  const redoDiscardedFiles = async (files: ReviewFile[]): Promise<boolean> => {
    const currentTurnId = store.currentTurnId();
    const discarded = files.filter((file) => file.turnIds.includes(currentTurnId ?? "") && file.status === "undone" && reviewCategory(file) === "discarded");
    if (discarded.length === 0) {
      void vscode.window.showInformationMessage("No discarded Codex changes are available to redo.");
      return false;
    }
    for (const file of discarded) {
      if (!await snapshotMatchesSide(file, "original", fileAccess)) {
        const choice = await vscode.window.showWarningMessage(
          "Codex Review cannot redo discarded changes because the current file no longer matches the captured original state.",
          "Open Diff",
        );
        if (choice === "Open Diff") {
          await openDiff(file);
        }
        return false;
      }
    }
    invalidateAllActionHistory(discarded);
    if (!await undo.applySnapshotSide(discarded, "post")) {
      void vscode.window.showErrorMessage("Codex Review could not reapply the discarded changes.");
      return false;
    }
    for (const file of discarded) {
      if (!await snapshotMatchesSide(file, "post", fileAccess)) {
        void vscode.window.showErrorMessage("Codex Review reapplied the batch, but its resulting file state did not match the captured Codex snapshot.");
        return false;
      }
    }
    store.setStatuses(discarded.map((file) => file.key), "pending");
    return true;
  };

  const requireFile = (argument?: unknown): ReviewFile | undefined => {
    const file = resolveFile(argument);
    if (!file) {
      void vscode.window.showInformationMessage("No pending Codex review is associated with the active file.");
    }
    return file;
  };

  const requireInteractiveFile = (argument?: unknown): ReviewFile | undefined => {
    const file = requireFile(argument);
    if (!file) {
      return undefined;
    }
    if (!file.turnIds.includes(store.currentTurnId() ?? "")) {
      void vscode.window.showInformationMessage("Older Codex turns are read-only archives. Their full and accepted diffs remain available.");
      return undefined;
    }
    return file;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("codexInlineReview.keepFile", (argument?: unknown) => {
      const file = requireInteractiveFile(argument);
      if (file) {
        const snapshots = store.snapshots([file.key]);
        invalidateBlockHistory(snapshots);
        if (store.keep(file.key)) {
          actionHistory.record("keep", snapshots);
        }
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.undoFile", async (argument?: unknown) => {
      const file = requireInteractiveFile(argument);
      if (file) {
        const snapshots = store.snapshots([file.key]);
        invalidateBlockHistory(snapshots);
        if (await undo.undo([file])) {
          actionHistory.record("undo", snapshots);
        }
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.discardFile", async (argument?: unknown) => {
      await vscode.commands.executeCommand("codexInlineReview.undoFile", argument);
    }),
    vscode.commands.registerCommand("codexInlineReview.redoFile", async (argument?: unknown) => {
      const file = requireInteractiveFile(argument);
      if (file) {
        await redoDiscardedFiles([file]);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.keepTurn", (argument?: unknown) => {
      const turnId = resolveTurnId(argument);
      const files = turnId && turnId === store.currentTurnId() ? filesForTurn(turnId).filter(hasPendingReviewBlocks) : [];
      if (files.length === 0) {
        void vscode.window.showInformationMessage("This turn has no active Codex changes to keep.");
        return;
      }
      const snapshots = store.snapshots(files.map((file) => file.key));
      invalidateAllActionHistory(snapshots);
      store.keepFiles(files.map((file) => file.key));
      actionHistory.record("keep", snapshots);
    }),
    vscode.commands.registerCommand("codexInlineReview.discardTurn", async (argument?: unknown) => {
      const turnId = resolveTurnId(argument);
      const files = turnId && turnId === store.currentTurnId() ? filesForTurn(turnId).filter((file) => file.status === "pending") : [];
      if (files.length === 0) {
        void vscode.window.showInformationMessage("This turn has no safely discardable pending changes.");
        return;
      }
      const snapshots = store.snapshots(files.map((file) => file.key));
      invalidateAllActionHistory(snapshots);
      if (await undo.undo(files)) {
        actionHistory.record("undo", snapshots);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.redoTurn", async (argument?: unknown) => {
      const turnId = resolveTurnId(argument);
      if (turnId && turnId === store.currentTurnId()) {
        await redoDiscardedFiles(filesForTurn(turnId));
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.keepBlock", async (argument?: unknown) => {
      const resolved = resolveBlock(argument);
      if (!resolved) {
        void vscode.window.showInformationMessage("That Codex review block is no longer available.");
        return;
      }
      const beforeReview = store.snapshots([resolved.file.key])[0];
      if (!beforeReview) {
        return;
      }
      const beforeText = await fileAccess.readText(resolved.file.uri);
      invalidateFileActionHistory(resolved.file);
      if (store.keepBlock(resolved.file.key, resolved.blockId)) {
        const afterReview = store.snapshots([resolved.file.key])[0];
        if (afterReview) {
          const afterText = await fileAccess.readText(resolved.file.uri);
          blockActionHistory.record("keep", beforeReview, afterReview, beforeText, afterText);
        }
      } else if (resolved.file.kind === "move") {
        void vscode.window.showWarningMessage("Move reviews can currently be resolved only as a whole file.");
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.undoBlock", async (argument?: unknown) => {
      const resolved = resolveBlock(argument);
      if (!resolved) {
        void vscode.window.showInformationMessage("That Codex review block is no longer available.");
        return;
      }
      const beforeReview = store.snapshots([resolved.file.key])[0];
      if (!beforeReview) {
        return;
      }
      const beforeText = await fileAccess.readText(resolved.file.uri);
      invalidateFileActionHistory(resolved.file);
      if (await undo.undoBlock(resolved.file, resolved.blockId)) {
        const afterReview = store.snapshots([resolved.file.key])[0];
        if (afterReview) {
          const afterText = await fileAccess.readText(resolved.file.uri);
          blockActionHistory.record("undo", beforeReview, afterReview, beforeText, afterText);
        }
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.keepAll", () => {
      const files = store.activeFiles();
      const snapshots = store.snapshots(files.map((file) => file.key));
      invalidateBlockHistory(snapshots);
      const count = store.keepAll();
      if (count > 0) {
        actionHistory.record("keep", snapshots);
        void vscode.window.showInformationMessage(`Kept ${count} Codex-reviewed file(s).`);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.undoAll", async () => {
      const files = store.activeFiles();
      const snapshots = store.snapshots(files.map((file) => file.key));
      invalidateBlockHistory(snapshots);
      if (await undo.undo(files)) {
        actionHistory.record("undo", snapshots);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.smartUndo", smartUndo),
    vscode.commands.registerCommand("codexInlineReview.smartRedo", smartRedo),
    vscode.commands.registerCommand("codexInlineReview.openDiff", async (argument?: unknown) => {
      const file = requireFile(argument);
      if (file) {
        await openDiff(file);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.openAcceptedDiff", async (argument?: unknown) => {
      const file = requireFile(argument);
      if (file) {
        await openAcceptedDiff(file);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.openInlineReview", async (argument?: unknown) => {
      const file = requireInteractiveFile(argument);
      if (file) {
        await virtualDocuments.openInline(file, vscode.window.activeTextEditor?.viewColumn);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.explainUndoUnavailable", (argument?: unknown) => {
      const file = resolveFile(argument);
      if (file) {
        void vscode.window.showWarningMessage(file.message ?? `Undo is unavailable while this review is ${file.status}.`);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.revealFile", async (argument?: unknown) => {
      const file = requireFile(argument);
      if (!file) {
        return;
      }
      if (file.status === "pending") {
        await virtualDocuments.openInline(file, vscode.window.activeTextEditor?.viewColumn);
        return;
      }
      if (file.kind === "delete") {
        await openDiff(file);
        return;
      }
      const uri = file.moveUri ?? file.uri;
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      const line = Math.min(file.markers.firstChangedLine, Math.max(0, document.lineCount - 1));
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }),
    vscode.commands.registerCommand("codexInlineReview.showPendingChanges", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.codexInlineReview");
      await vscode.commands.executeCommand("codexInlineReview.pendingChanges.focus");
    }),
    vscode.commands.registerCommand("codexInlineReview.watchSessionById", async () => {
      const input = await vscode.window.showInputBox({
        title: "Watch Codex Session by ID",
        prompt: "Enter the Codex session UUID embedded in its rollout filename.",
        value: pinnedSessionId(context.workspaceState, codexHome) ?? "",
        validateInput: (value) => {
          try {
            normalizeSessionId(value);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      });
      if (!input) {
        return;
      }
      try {
        const normalized = normalizeSessionId(input);
        const loaded = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Codex Review: loading session ${normalized}`,
            cancellable: false,
          },
          () => loadPinnedSession(normalized),
        );
        await savePinnedSessionId(context.workspaceState, codexHome, normalized);
        void vscode.window.showInformationMessage(
          `Codex Review loaded ${loaded.turnCount} turn(s) and is now watching session ${normalized}.`,
          "Show Diagnostics",
        ).then((choice) => {
          if (choice === "Show Diagnostics") {
            void vscode.commands.executeCommand("codexInlineReview.showDiagnostics");
          }
        });
        output.info(`Pinned rollout: ${loaded.filePath}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.error(`Could not pin Codex session: ${message}`);
        void vscode.window.showErrorMessage(`Codex Review could not watch that session: ${message}`);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.stopWatchingSessionById", async () => {
      if (activePinnedSessionId) {
        await decisionSave;
        await saveReviewDecisions(
          context.workspaceState,
          codexHome,
          activePinnedSessionId,
          store.storedReviewDecisions(),
        );
      }
      activePinnedSessionId = undefined;
      const stopped = source.stopWatchingSessionById();
      await savePinnedSessionId(context.workspaceState, codexHome);
      void vscode.window.showInformationMessage(stopped
        ? "Codex Review stopped watching the pinned session and resumed automatic discovery."
        : "Codex Review is already using automatic session discovery.");
    }),
    vscode.commands.registerCommand("codexInlineReview.importRecentEvents", async () => {
      let seconds = configuration().get<number>("importRecentSeconds", 0);
      if (seconds <= 0) {
        const input = await vscode.window.showInputBox({
          title: "Import Recent Codex Events",
          prompt: "How many seconds of completed file-change events should be imported?",
          value: "300",
          validateInput: (value) => /^\d+$/u.test(value) && Number(value) > 0 ? undefined : "Enter a positive whole number.",
        });
        if (!input) {
          return;
        }
        seconds = Number(input);
      }
      try {
        const imported = await source.importRecent(seconds);
        void vscode.window.showInformationMessage(`Imported ${imported} Codex change event(s).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.error(`Recent event import failed: ${message}`);
        void vscode.window.showErrorMessage(`Codex Review import failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand("codexInlineReview.showOutput", () => output.show(true)),
    vscode.commands.registerCommand("codexInlineReview.showDiagnostics", async () => {
      const diagnostics = source.getDiagnostics();
      const lines = [
        `Extension host kind: ${extensionHostKind(context)}`,
        `Remote name: ${vscode.env.remoteName ?? "none"}`,
        `Resolved Codex home: ${codexHome}`,
        `Watched session directory: ${diagnostics.watchedSessionDirectory ?? "not started"}`,
        `Watch mode: ${diagnostics.pinnedSessionId ? `pinned session ${diagnostics.pinnedSessionId}` : "automatic"}`,
        `Pinned rollout: ${diagnostics.pinnedRollout ?? "none"}`,
        `Tracked rollouts: ${diagnostics.trackedRollouts ?? 0}`,
        `Newest rollout discovered: ${diagnostics.newestRollout ?? "none"}`,
        `Last processed offset: ${diagnostics.lastProcessedOffset ?? "none"}`,
        `Pending reviews: ${store.activeFiles().length}`,
      ];
      if (vscode.env.remoteName && !diagnostics.newestRollout) {
        lines.push("Remote limitation: this workspace extension host can only observe Codex sessions stored in the same remote environment. Local rollout files are not visible here.");
      }
      output.appendLine(lines.join("\n"));
      output.show(true);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      actionHistory.clear();
      blockActionHistory.clear();
      store.clear();
      output.warn("Workspace folders changed. Pending snapshots were cleared defensively; reload the window to rebuild path guards.");
    }),
  );

  if (!configuration().get<boolean>("enabled", true)) {
    output.info("Codex rollout watching is disabled by configuration.");
    return;
  }
  if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
    output.warn("No workspace folder is open; rollout events will be ignored until a workspace is opened and the window is reloaded.");
  }
  const savedPinnedSessionId = pinnedSessionId(context.workspaceState, codexHome);
  if (savedPinnedSessionId) {
    try {
      await loadPinnedSession(savedPinnedSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.warn(`Saved pinned session could not be restored; automatic discovery will be used: ${message}`);
      await savePinnedSessionId(context.workspaceState, codexHome);
      void vscode.window.showWarningMessage(`Codex Review could not restore pinned session ${savedPinnedSessionId}; automatic discovery resumed.`);
    }
  }
  const configuredRecentSeconds = configuration().get<number>("importRecentSeconds", 0);
  const recentSeconds = Number.isFinite(configuredRecentSeconds) ? Math.max(0, configuredRecentSeconds) : 0;
  if (recentSeconds > 0) {
    try {
      await source.importRecent(recentSeconds);
    } catch (error) {
      output.error(`Configured recent event import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await source.start();
  output.info(`Watching Codex rollouts from ${codexHome} every ${pollInterval} ms.`);
}

export function deactivate(): void {
  // Disposables registered on ExtensionContext own all cleanup.
}
