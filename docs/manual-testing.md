# Manual test plan

## Local VS Code or Cursor

1. Run `npm run package` and install the generated VSIX with **Extensions: Install from VSIX...**.
2. Open a disposable workspace and leave `importRecentSeconds` at zero.
3. Ask through the existing Codex extension to update one file, update one file in multiple hunks, add a file, and delete a file.
4. Confirm Codex edits do not automatically open a review editor. Open the review from the sidebar and confirm red old rows, green new rows, changed-substring highlights, and one Keep/Undo control pair per block.
5. Keep one block in a multi-block file. Confirm that block disappears while its current text and every other pending block remain unchanged.
6. Undo a different block. Confirm only that block returns to its old text and every other pending block remains unchanged.
7. With the review editor focused, press Ctrl+Z and confirm only the latest block decision is reversed. Undo and redo multiple decisions in order.
8. Focus a normal file or diff editor and confirm Ctrl+Z uses normal editor history without resolving a background review.
9. Keep one whole file and confirm no disk write occurs.
10. Undo each change kind and confirm exact contents or absence are restored and saved.
11. Modify a reviewed file manually, then invoke Undo. Confirm it refuses the overwrite, marks a conflict, and offers a diff.
12. Keep a reviewed file, undo the review decision, and confirm the Codex result regains its review controls. Redo it and confirm it returns to Accepted.
13. Discard a reviewed file, undo the review decision, and confirm the Codex result and review UI return together. Redo it and confirm the original content is restored.
14. Fork the active Codex chat. Confirm copied parent events do not recreate resolved reviews, while a genuine new edit in the fork creates a new review.
15. Confirm the sidebar hierarchy is Turn → Pending / Accepted / Partially Accepted / Discarded → files.
16. Discard a pending file and confirm it moves to Discarded. Redo it and confirm the captured Codex edit returns to Pending.
17. Discard a pending turn and confirm all pending files change atomically. Redo the turn and confirm all captured edits return atomically.
18. Accept one block in a multi-block file. Confirm the file remains Pending, unresolved controls remain, Full Diff shows the complete proposal, and Accepted Diff shows only accepted blocks.
19. Resolve every block and confirm the file moves to Accepted, Partially Accepted, or Discarded according to the decisions.
20. Create a new Codex turn while the previous turn still has pending blocks. Confirm the previous remainder is accepted, the previous turn collapses into a read-only archive, and its inline review tab closes.
21. Edit the same file in consecutive turns. Confirm each turn retains independent full and accepted snapshots.
22. Try to reopen an archived inline review and confirm it remains unavailable while archival diffs still open.
23. Append an incomplete JSON line to a disposable rollout copy, then complete it. Confirm processing occurs only after the newline. Rotate or truncate the copy and confirm no duplicate events appear.
24. Continue an older session after a newer rollout exists. Confirm automatic mode captures newly appended edits from both sessions without importing their old history.
25. Run **Codex Review: Watch Session by ID** and select an older rollout UUID. Confirm every completed file-change turn from that rollout appears, older turns are archived, only the last turn is interactive, and only subsequent edits from that session are tailed.
26. Run **Codex Review: Stop Watching Session by ID** and confirm diagnostics report automatic mode and new edits from other recent sessions are captured again.
27. Confirm the review sidebar title no longer contains global Keep All or Undo All buttons, while both commands remain available from the Command Palette.
28. Open an inline review and confirm Keep Change has a green marker and Undo Change has a red marker.
29. In a pinned session, keep one block, undo another, and leave a third unresolved. Reload the window and confirm the file is still Pending with the accepted subset and remaining control; resolve the last block and confirm it becomes Partially Accepted.
30. Select a different session ID and confirm turns from the previous session leave the sidebar. Select the first ID again and confirm its stored review classifications return.

## Remote SSH

1. Connect to an SSH workspace and install or enable the VSIX in the remote extension host.
2. Confirm diagnostics show `workspace (remote)`, the remote name, the remote user's Codex home, watch mode, tracked rollout count, and watched date directory.
3. Run Codex in the same remote environment and repeat the relevant review workflows above.
4. Run Codex only on the local machine and confirm diagnostics explain that local rollout files are not visible to the remote extension host.
5. Pin the active remote session by UUID, reload the remote window, and confirm its turn history and review classifications are restored before monitoring continues from the stored byte offset.
