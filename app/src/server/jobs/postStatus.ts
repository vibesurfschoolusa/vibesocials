import type { PostJobResultStatus, PostJobStatus } from "@prisma/client";

/**
 * Roadmap Phase 3 — pure PostJob status recompute.
 *
 * A PostJob's overall status is a deterministic function of ALL of its
 * per-platform `PostJobResult`s. Extracted here (side-effect-free, no DB) so it
 * can be unit-tested in isolation and shared by both the initial publish
 * finalize (`publishToAllPlatforms`) and the retry finalize (`retryPlatforms`)
 * in `inngest-functions.ts` — a single source of truth means a retry that
 * flips one platform back to `pending` and re-runs it recomputes the job the
 * exact same way the first publish did.
 *
 * The rule, evaluated over the FULL result set:
 *  - `in_progress` — at least one result is still `pending` (in-flight or
 *    freshly re-queued by a retry). There is no `pending` PostJobStatus for the
 *    running case; `pending` is only a PostJob's initial pre-run state, so the
 *    not-yet-done state is modelled as `in_progress`.
 *  - `completed` — no result is `pending` AND at least one `success`. A partial
 *    success (some platforms failed) still counts as completed: the post did go
 *    live somewhere, and the failed platforms are individually retryable.
 *  - `failed` — every result is terminal (none `pending`) AND none `success`.
 *
 * The empty set (no results) yields `failed`: it satisfies "all terminal and
 * none success" vacuously. In practice a job always has ≥1 result (publishing
 * requires ≥1 connection), so this is only a defensive default.
 *
 * Behavior-preserving note: for the all-platforms-just-ran case the original
 * inline finalize computed `results.some(success) ? "completed" : "failed"`.
 * When no result is pending (every platform has run), this function reduces to
 * exactly that, so the existing publish path's outcomes are unchanged.
 */
export function recomputePostJobStatus(
  results: { status: PostJobResultStatus }[],
): PostJobStatus {
  const anyPending = results.some((r) => r.status === "pending");
  if (anyPending) {
    return "in_progress";
  }

  const anySuccess = results.some((r) => r.status === "success");
  if (anySuccess) {
    return "completed";
  }

  return "failed";
}
