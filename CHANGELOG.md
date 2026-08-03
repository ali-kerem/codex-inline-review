# Changelog

## 0.2.0 — 2026-08-03

- Load every completed file-change turn from a session when **Watch Session by ID** is used.
- Keep older selected-session turns as read-only archives while leaving only the final turn interactive.
- Preserve in-memory review decisions when a session is selected again.
- Persist content-free block decisions so Pending, Accepted, Partially Accepted, and Discarded states survive reloads without storing source contents.
- Reconstruct histories across multiple events in one turn and across add/delete lifecycles.
- Follow appended edits from recent and previously checkpointed rollouts instead of assuming the newest rollout is the active chat.
- Add persistent **Watch Session by ID** and **Stop Watching Session by ID** commands.
- Report automatic or pinned watch mode and tracked rollout details in diagnostics.
- Remove global Keep All and Undo All buttons from the review sidebar title.
- Add green and red visual markers to the per-block Keep Change and Undo Change controls.

## 0.1.0 — 2026-08-02

- Initial public experimental release.
- Passive review integration with existing Codex sessions.
- Turn-based pending, accepted, partially accepted, discarded, and archived reviews.
- Per-block Keep and Undo controls in read-only inline review documents.
- Full and accepted-only virtual diffs without Git or private editor APIs.
- Guarded, saved file undo/redo with conflict detection.
- Local and Remote SSH workspace-extension support.
