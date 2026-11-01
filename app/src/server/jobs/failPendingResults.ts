import type { Platform, PostJobStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { recomputePostJobStatus } from "@/server/jobs/postStatus";

/** Why a job's still-pending results are being failed. */
export interface PendingResultFailure {
  /** Internal classification stored on each result (never shown to users). */
  errorCode: string;
  /** Sanitized, user-facing reason stored on each result. */
  errorMessage: string;
}

/**
 * The publish event couldn't be handed to Inngest AFTER the job was committed
 * `in_progress` (2026-11-01 audit). The routes return the same code + message
 * in their 503 body.
 */
export const DISPATCH_FAILURE = {
  errorCode: "DISPATCH_FAILED",
  errorMessage: "Couldn't start publishing. Please try again.",
} as const satisfies PendingResultFailure;

/**
 * Fail every still-`pending` PostJobResult of a job with `failure`'s code and
 * message, then recompute the job's status over ALL its results with the same
 * rule the publish pipeline uses (`recomputePostJobStatus`), so a job whose
 * run never started — or was cut short — can't sit `in_progress` forever.
 * Results that already finished are untouched: a platform that went live stays
 * live (the job then reads `completed`, and the failed rows are retryable).
 *
 * Shared by every route that dispatches `post/publish.requested` (on an
 * `inngest.send` failure) and the publish functions' Inngest `onFailure`
 * handlers — hence the parameterized failure. Mirrors retryPlatforms'
 * fail-media-unavailable step in inngest-functions.ts.
 *
 * `options.platforms` (Task 4 fix round 1, ruling R8b) narrows the write to
 * those platforms' pending results — a dead RETRY run may only fail what it
 * re-queued, since another run of the same job can still own the rest. The
 * status recompute always covers ALL results. Omitted = every pending result
 * (unchanged for existing callers).
 */
export async function failPendingPostJobResults(
  postJobId: string,
  failure: PendingResultFailure,
  options: { platforms?: Platform[] } = {},
): Promise<{ failedCount: number; status: PostJobStatus }> {
  const { platforms } = options;
  const { count } = await prisma.postJobResult.updateMany({
    where: {
      postJobId,
      status: "pending",
      ...(platforms ? { platform: { in: platforms } } : {}),
    },
    data: {
      status: "failed",
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
    },
  });

  const results = await prisma.postJobResult.findMany({
    where: { postJobId },
    select: { status: true },
  });
  const status = recomputePostJobStatus(results);

  await prisma.postJob.update({
    where: { id: postJobId },
    data: { status },
  });

  return { failedCount: count, status };
}
