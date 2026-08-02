# Codex Inline Review (Experimental)

Codex Inline Review is an experimental workspace extension for VS Code and Cursor. It passively observes completed file edits made by the existing Codex extension and presents them as pending reviews:

- selecting a pending file in the sidebar opens a read-only, single-column inline review tab with old rows in red above new rows in green; Codex edits never open an editor automatically;
- paired modified rows receive stronger red/green highlights over the exact changed substring;
- each contiguous change block receives independent **Keep Change** and **Undo Change** CodeLens actions in the dedicated review tab;
- the underlying writable file remains a clean, normal file tab with Codex's current text and receives validated block-level writes without review decorations;
- the extension-owned Codex Review tree is organized as Turn → Pending / Accepted / Partially Accepted / Discarded → files;
- a status-bar item shows the number of active file reviews.

The extension does not use Git, SCM, Cursor databases, private editor commands, proposed VS Code APIs, or telemetry. It never submits prompts and does not start a second Codex client.

## Installation

Download `codex-inline-review-0.1.0.vsix` from the latest GitHub Release, then run **Extensions: Install from VSIX...** in VS Code or Cursor and reload the window.

Release VSIX files are generated from Git tags by the repository's GitHub Actions release workflow. Generated `*.vsix`, `out/`, rollout files, logs, and dependencies are intentionally excluded from Git.

## Important experimental status

The working event source reads Codex rollout JSONL files from `$CODEX_HOME/sessions/YYYY/MM/DD`. This is a read-only integration with an undocumented persisted rollout format. That schema can change between Codex versions.

The public [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) is the preferred future integration point. It documents authoritative completed `fileChange` items through `item/completed` and aggregated turn snapshots through `turn/diff/updated`. Those notifications are not the same schema as persisted rollout records. The implementation therefore has a normalized `ChangeBatch` model, a `ChangeEventSource` interface, and separate rollout/app-server adapters.

Starting another app-server would create a separate connection/session and would not passively receive edits from the Codex session already owned by the installed Codex extension. For that reason, this MVP starts only the rollout watcher.

Cursor's native Agent review renderer and VS Code's deleted-line view zones are not exposed as stable extension APIs. A `QuickDiffProvider` can provide original contents, but VS Code owns its gutter markers and inline peek widget; it does not let an extension permanently insert those deleted rows into a normal writable text editor. Copying the open-source renderer would still depend on inaccessible private workbench/Monaco services. This extension therefore builds the closest supported equivalent as a virtual read-only text document: it has one line-number column, preserves the file's language mode, interleaves red deleted rows above green added rows, and adds stronger intraline decorations. The writable file itself is deliberately undecorated. **Open Full Diff** remains available from each file's sidebar context menu.

If the read-only review tab is closed while blocks remain pending, reopen it from any of these places:

- select the editor-title **Open Inline Review** icon;
- right-click inside the writable file and select **Codex Review: Open Inline Review**;
- select the pending file in the Codex Review tree;
- run **Codex Review: Open Inline Review** from the Command Palette.

The **Codex Review** activity-bar container and its Changes tree are provided by this extension. Turns are the top-level entries. Every turn contains these sections:

- **Pending**: files whose change blocks still need decisions;
- **Accepted**: files whose Codex changes were accepted completely;
- **Partially Accepted**: fully resolved files containing a mixture of accepted and discarded blocks;
- **Discarded**: files whose Codex changes were discarded completely.

Only the newest turn is interactive. Turn labels use `Turn {ID} HH:MM DD.MM.YYYY` in the extension host's local time, and inline review tabs append the same label in parentheses after the filename. When a newer turn arrives, every unresolved block in the previous turn is accepted without a disk write, that turn receives a new collapsed tree identity, its inline review tabs close, and its review undo/redo journal is closed. Archived inline reviews cannot be reopened; archived full and accepted diffs remain available. Archived turns never expose Keep, Discard, or Redo actions and keep independent per-turn snapshots even when a newer turn edits the same path.

While any block still needs a decision, its file remains under **Pending**, even after one or more blocks are accepted. Such a pending file exposes **Open Accepted Diff** as soon as it has an accepted subset. Only after every block is resolved can the file move to **Accepted**, **Partially Accepted**, or **Discarded**. Selecting a partially accepted file opens its accepted-only diff; selecting an accepted or discarded file opens the full diff. **Open Full Diff** compares the immutable original with the complete Codex proposal. **Open Accepted Diff** compares the immutable original with only the accepted subset. Diff commands are intentionally not shown beside the per-block inline controls.

## Keep and Undo semantics

**Keep Change** accepts only its selected contiguous diff block. It does not write the file. **Undo Change** validates the complete current-file hash, reverses only the selected block in one `WorkspaceEdit`, saves the resulting file immediately, and leaves every other pending block unchanged. After either action, the inline review document is rebuilt and only unresolved blocks retain controls. Each block decision records its exact before/after review state and live file text: while the inline review editor is focused, Ctrl+Z restores only the most recent block decision and its controls, while redo reapplies only that decision. Multiple block decisions unwind and replay in order. Move operations remain file-wide because path movement is not a line block.

**Keep File** accepts the current file state by clearing its active review and decorations. It does not write the file. **Keep All** is also write-free.

Whole-file Keep/Undo resolutions use the same guarded journal. Pressing Ctrl+Z (Cmd+Z on macOS) immediately afterward restores the same review UI, CodeLens controls, decorations, and validated content snapshot. Redo reapplies the resolution. If unrelated text edits occurred afterward, the extension never forces a stale review onto mismatched content.

Only a focused inline review document intercepts Ctrl+Z and review redo. Normal file editors, diff editors, and background review tabs use normal editor undo/redo and cannot resolve a review accidentally. While the focused review is still pending, Ctrl+Z performs the same validated operation as **Undo File**, saves the resulting file, clears the review UI, and records that resolution in the review undo/redo journal.

**Undo File** first compares the current file state with the captured post-edit SHA-256 hash:

- update: replace the file with the exact reconstructed original text;
- add: delete the created file only while its hash still matches;
- delete: recreate the exact original only while the path remains absent;
- move: recreate the original source and remove the unchanged destination in one validated workspace edit.

**Undo All** validates every active file before applying any write. If any file changed afterward, the whole batch is refused. The review becomes conflicted and offers a diff instead of overwriting user or tool edits.

Every review-driven `WorkspaceEdit` is saved before its review state advances. This keeps the editor buffer and on-disk file synchronized before a later Codex turn produces another patch.

For updates, the original is reconstructed by exactly reverse-applying the unified diff to the post-edit file. If hunk contents, line counts, line endings, or final-newline state do not match, reconstruction fails visibly. The review remains read-only and Undo is unavailable; the extension never guesses or writes reconstructed content automatically.

Pending source contents and hashes stay in extension-host memory and are disposed with the workspace. Only rollout path/identity/offset metadata is stored in workspace state. With `importRecentSeconds: 0`, every activation still starts existing files at EOF as configured; checkpoints support safe tail bookkeeping without persisting source text.

## Configuration

| Setting | Default | Meaning |
| --- | ---: | --- |
| `codexInlineReview.enabled` | `true` | Enables rollout watching. |
| `codexInlineReview.codexHome` | empty | Optional absolute Codex home path. |
| `codexInlineReview.pollIntervalMs` | `750` | Poll interval; values below 250 ms are clamped. |
| `codexInlineReview.importRecentSeconds` | `0` | Existing history imported at activation. Zero begins at EOF except for a safe saved checkpoint. |

Codex home resolution order is:

1. `codexInlineReview.codexHome`;
2. `CODEX_HOME` in the extension host;
3. `path.join(os.homedir(), ".codex")` in the extension host.

Use **Codex Review: Import Recent Events** to explicitly import a recent time window. The watcher otherwise monitors only the current date directory and switches directories at day rollover; it never repeatedly walks the complete sessions tree.

Forked Codex threads are detected from the persisted `session_meta.forked_from_id` marker. Copied events timestamped before the fork are ignored, so forking a chat does not add, remove, or replace editor review state. Genuine file edits created after the fork continue to produce reviews normally.

## Commands

- `Codex Review: Keep Change`
- `Codex Review: Undo Change`
- `Codex Review: Keep File`
- `Codex Review: Undo File`
- `Codex Review: Keep All`
- `Codex Review: Undo All`
- `Codex Review: Keep All Changes in Turn`
- `Codex Review: Discard All Changes in Turn`
- `Codex Review: Redo All Discarded Changes in Turn`
- `Codex Review: Discard File Changes`
- `Codex Review: Redo Discarded File Changes`
- `Codex Review: Open Full Diff`
- `Codex Review: Open Accepted Diff`
- `Codex Review: Open Inline Review`
- `Codex Review: Show Pending Changes`
- `Codex Review: Import Recent Events`
- `Codex Review: Show Output`
- `Codex Review: Show Diagnostics`

Diagnostics report only the extension-host kind, `vscode.env.remoteName`, resolved Codex home, watched date directory, newest rollout path, last processed byte offset, and pending review count. They never include rollout lines, prompts, reasoning, diffs, or file contents.

## Remote SSH

The manifest declares `"extensionKind": ["workspace"]`, so the extension runs in the Remote SSH workspace extension host. Codex home, the host home directory, rollout tailing, workspace path validation, and file operations all occur in that environment. Workspace content is read through `vscode.workspace.fs`, and undo writes are applied with `WorkspaceEdit`.

The rollout watcher can see only session files stored in the same environment as the extension host. If Cursor runs the Codex session locally while the workspace extension runs remotely, local rollout files are not visible. Run **Codex Review: Show Diagnostics**; when no remote rollout is found, the output calls out this limitation explicitly.

## Development

```sh
npm install
npm test
npm run compile
npm run package
```

Tests use minimized copies containing only `patch_apply_end` records from the captured rollout, plus deterministic before/after text fixtures. Production code does not parse unrelated response, reasoning, conversation, or token-count records.

## Manual test plan

### Local Cursor

1. Run `npm run package` and install the generated VSIX with **Extensions: Install from VSIX**.
2. Open a disposable workspace and leave `importRecentSeconds` at zero.
3. Ask through the existing Codex extension to update one file, update one file in multiple hunks, add a file, and delete a file.
4. Confirm the writable file has no Codex review decorations and the active edited file opens separately as a single-column review document with red old rows above green new rows, stronger changed-substring colors, and one set of **Keep Change**/**Undo Change** controls per block.
5. Keep one block in a multi-block file. Confirm that block disappears from the review while its current text and every other pending block remain unchanged.
6. Undo a different block. Confirm only that block returns to its old text in the underlying file and every other pending block remains unchanged.
7. Press Ctrl+Z and confirm only the block decision from step 6 is reversed and its review controls return. Press Ctrl+Z again and confirm only the decision from step 5 is reversed. Redo both and confirm they replay in order.
8. Keep one whole file and confirm no disk write occurs.
9. Undo each change kind and confirm exact contents or absence are restored.
10. Create another Codex edit, modify that file manually, then invoke Undo. Confirm it refuses the overwrite, marks a conflict, and offers a diff.
11. Keep a reviewed file, press Ctrl+Z/Cmd+Z, and confirm the unchanged Codex result regains its review controls and decorations. Redo and confirm it returns to kept state.
12. Undo a reviewed file, press Ctrl+Z/Cmd+Z, and confirm the Codex result and review UI return together. Redo and confirm the file returns to the reconstructed original with no active review.
13. Fork the active Codex chat. Confirm existing review UI remains exactly as it was and resolved reviews do not reappear. Make a new edit in the fork and confirm only that new edit is reviewed.
14. Leave a new review pending with no preceding block decision and press Ctrl+Z/Cmd+Z. Confirm the exact remaining Codex patch is undone and all review UI clears.
15. Confirm the sidebar hierarchy is Turn → Pending / Accepted / Partially Accepted / Discarded → files.
16. Discard a pending file and confirm it moves to **Discarded**; redo it and confirm the exact Codex edit is restored and moves back to **Pending**.
17. Right-click a turn, discard it, and confirm all of its pending files move atomically to **Discarded**. Redo the turn and confirm all captured changes return atomically to **Pending**.
18. Accept one block in a multi-block file. Confirm the file remains under **Pending**, its unresolved blocks retain **Keep Change**/**Undo Change**, **Open Full Diff** shows the complete proposal, and **Open Accepted Diff** shows only the accepted block.
19. Resolve every block and confirm the file moves to **Accepted**, **Partially Accepted**, or **Discarded** according to the final decisions. Confirm active Accepted and Discarded files expose only the full diff action.
20. Keep a pending file and then a whole turn; confirm they move to **Accepted** without changing file contents.
21. Right-click sidebar files and confirm **Open Full Diff** is available there but no longer appears beside inline block controls.
22. Create a new Codex turn while the previous turn still has pending blocks. Confirm the previous remainder is accepted, the previous turn becomes an archive with diff-only menus, and only the new turn has interactive review actions.
23. Edit the same file in two consecutive turns. Confirm each turn retains its own full/accepted snapshots and the archived file never returns to Pending when the newer event arrives.
24. Append an incomplete JSON line to a disposable rollout copy, then complete it; confirm processing occurs only after the newline. Rotate/truncate the copy and confirm diagnostics advance without duplicate notifications.

### Remote SSH

1. Connect to an SSH workspace and install/enable the VSIX in the remote extension host.
2. Confirm diagnostics show `workspace (remote)`, the remote name, and the remote user's Codex home/date directory.
3. Run Codex in the same remote environment and confirm reviews, virtual diffs, Keep, and Undo behave as above.
4. Run Codex only on the local machine and confirm diagnostics clearly explain that local rollouts are not visible to the remote extension host.
