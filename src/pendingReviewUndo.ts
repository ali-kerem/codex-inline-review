import type { ReviewFile } from "./reviewStore";

interface PendingReviewUndoOperations {
  snapshots(file: ReviewFile): ReviewFile[];
  apply(file: ReviewFile): Promise<boolean>;
  record(snapshots: ReviewFile[]): void;
}

export async function interceptPendingReviewUndo(
  file: ReviewFile | undefined,
  operations: PendingReviewUndoOperations,
): Promise<boolean> {
  if (!file || file.status !== "pending") {
    return false;
  }

  const snapshots = operations.snapshots(file);
  if (await operations.apply(file)) {
    operations.record(snapshots);
  }
  return true;
}
