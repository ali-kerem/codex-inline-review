# Technical notes

## Experimental integration

The extension passively reads Codex rollout JSONL files from `$CODEX_HOME/sessions/YYYY/MM/DD`. This persisted rollout format is undocumented and may change between Codex versions.

The public [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) is the preferred future integration point. App-server notifications such as `item/completed` and `turn/diff/updated` do not use the same schema as persisted rollout records. The extension therefore normalizes both formats behind adapters and a shared `ChangeBatch` model. It does not start another app-server because that separate process would not receive events from the Codex session already owned by the installed Codex extension.

The rollout watcher tails only relevant session files, handles partial lines and file replacement, deduplicates patch events, detects fork boundaries, and accepts only completed successful changes inside the open workspace.

## Rendering approach

The extension renders reviews in virtual, read-only text documents using stable VS Code APIs.

The virtual review document:

- interleaves removed rows above added rows;
- highlights changed substrings within modified lines;
- preserves the file's language mode;
- exposes one Keep/Undo CodeLens pair per contiguous change block;
- leaves the normal writable file editor undecorated.

Full and accepted-only comparisons use virtual documents and `vscode.diff`.

## Review state and turn lifecycle

Reviews are grouped by turn and file. The latest turn is interactive. Older turns are collapsed, read-only archives with independent snapshots. When a newer turn arrives, unresolved changes in the previous turn are accepted without an additional disk write, inline review tabs from that turn close, and its review action history is retired. Archived full and accepted-only diffs remain available.

A file remains Pending while any block still needs a decision. After every block is resolved, it becomes Accepted, Partially Accepted, or Discarded. Immutable full-original and full-proposal snapshots are retained so an accepted-only diff can be shown independently of the complete Codex diff.

If a later patch in the same turn modifies an already pending file, the extension composes it only when the previous post-edit hash exactly matches the next inferred original. Otherwise the review becomes conflicted.

Review source contents and hashes remain in extension-host memory. Only rollout path, identity, and offset checkpoints are stored in workspace state.

## Keep, discard, undo, and redo safety

Keep accepts Codex content without writing it again. Undo or Discard validates the current file against the captured post-edit snapshot before changing anything.

- Update: restore the reconstructed original text.
- Add: delete the created file only while its content still matches.
- Delete: recreate the original only while the path remains absent.
- Move: restore the original source and remove the unchanged destination together.

Multi-file operations validate every file before applying any write. A mismatch refuses the operation and offers a diff instead of overwriting later edits. Review-driven `WorkspaceEdit` operations are saved before review state advances.

Review Ctrl+Z/redo handling is active only while the interactive virtual review document is focused. It records exact review and file snapshots so individual block decisions and whole-file decisions can be reversed in order. Normal file and diff editors retain normal editor undo/redo behavior.

Original content for updates is reconstructed by exactly reverse-applying the unified diff to the post-edit file. Hunk, line-ending, or final-newline mismatches cause a visible reconstruction failure; the extension does not guess.

## Configuration details

Codex home is resolved in this order:

1. `codexInlineReview.codexHome`;
2. `CODEX_HOME` in the extension host;
3. `path.join(os.homedir(), ".codex")` in the extension host.

With `codexInlineReview.importRecentSeconds: 0`, activation starts existing rollout files at EOF. **Codex Review: Import Recent Events** explicitly imports a recent window. The watcher monitors the current date directory and handles day rollover without repeatedly scanning the complete sessions tree.

Forked Codex threads are detected from the persisted `session_meta.forked_from_id` marker. Copied parent events are suppressed, while genuine edits created after the fork continue to produce reviews.

## Remote SSH

The extension declares `"extensionKind": ["workspace"]` and runs in the Remote SSH workspace extension host. Codex home resolution, rollout tailing, path validation, and file operations occur in that environment.

The watcher can see only sessions stored in the same environment as the extension host. If Codex writes sessions locally while the extension runs remotely, those local files are not visible. **Codex Review: Show Diagnostics** reports this limitation.

Diagnostics contain only the extension-host kind, remote name, resolved Codex home, watched directory, newest rollout path, last processed byte offset, and pending-review count. They do not contain prompts, reasoning, diffs, or file contents.

## Development and packaging

```sh
npm install
npm test
npm run compile
npm run package
```

Tests use minimized `patch_apply_end` fixtures and deterministic before/after file content. Production code does not depend on unrelated conversation, reasoning, or token-count records.

See [manual-testing.md](manual-testing.md) for the full local and Remote SSH verification checklist.
