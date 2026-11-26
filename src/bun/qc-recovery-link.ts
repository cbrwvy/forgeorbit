/** Tiny lookup so QC settlement can see a recovery grant without a module cycle. */
import { db } from "./db.ts";

export function recoveryGrantIdForReview(reviewId: string): string | null {
  return db.query<{ id: string }, [string]>(
    `SELECT id FROM qc_recovery_grants WHERE review_id = ?`,
  ).get(reviewId)?.id ?? null;
}
