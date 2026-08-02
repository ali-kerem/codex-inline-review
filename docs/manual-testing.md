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

## Remote SSH

1. Connect to an SSH workspace and install or enable the VSIX in the remote extension host.
2. Confirm diagnostics show `workspace (remote)`, the remote name, and the remote user's Codex home and watched date directory.
3. Run Codex in the same remote environment and repeat the relevant review workflows above.
4. Run Codex only on the local machine and confirm diagnostics explain that local rollout files are not visible to the remote extension host.
