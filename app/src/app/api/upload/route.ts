import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { UPLOAD_ALLOWED_CONTENT_TYPES } from "@/lib/mediaInput";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext } from "@/lib/workspace";
import { workspaceBlockResponse } from "@/lib/workspaceStatus";
import { checkStorageLimit } from "@/server/usage/workspaceUsage";

/**
 * GET /api/upload — why the active workspace cannot upload, if it cannot.
 * `upload()` from @vercel/blob/client drops the body of a refused token request
 * and throws a generic error, so Create and the Media page ask here to show the
 * storage sentence instead (lib/uploadFailure.ts).
 */
export async function GET(): Promise<NextResponse> {
  const context = await getWorkspaceContext();
  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Each call sums the workspace's storage, so it is throttled. Over the limit it
  // answers "not full": the caller then shows the upload's own error.
  const rateLimit = await checkRateLimit({
    userId: context.user.id,
    route: "upload/status",
    limit: 60,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json({ storageFull: false });
  }
  const refusal = await checkStorageLimit(context.workspace.id);
  return NextResponse.json(refusal ? { storageFull: true, ...refusal } : { storageFull: false });
}

export async function POST(request: Request): Promise<NextResponse> {
  // Usage limits (2026-11-10): the active workspace, whose storage the upload uses.
  const context = await getWorkspaceContext();

  if (!context) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Pause (2026-11-10): a paused workspace cannot create or move work.
  const blocked = workspaceBlockResponse(context.workspace);
  if (blocked) return blocked;

  const { user } = context;

  // Cap client upload-token issuance (each call can authorize up to 512MB).
  // 120 per 15 minutes: a post with ten photos takes ten tokens (07c).
  const rateLimit = await checkRateLimit({
    userId: user.id,
    route: "upload",
    limit: 120,
    windowMs: 15 * 60 * 1000,
    failClosed: true,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many uploads. Please slow down.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) },
      },
    );
  }

  // Parsed before the try below: a malformed body used to throw straight out
  // of the handler as an unhandled 500. `handleUpload` validates the body's
  // shape itself (an unknown `type` throws into the catch -> 400).
  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }

  // Usage limits (2026-11-10): no new token once the workspace's media is at or
  // over its storage limit. Checked before the file exists, so one upload can
  // take it over the limit; that is accepted.
  if (body.type === "blob.generate-client-token") {
    const refusal = await checkStorageLimit(context.workspace.id);
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 403 });
    }
  }

  try {
    const jsonResponse = await handleUpload({
      body: body as unknown as HandleUploadBody,
      request,
      onBeforeGenerateToken: async (pathname) => {
        logger.info("[Upload] Generating token", { pathname, userId: user.id });

        return {
          allowedContentTypes: [...UPLOAD_ALLOWED_CONTENT_TYPES],
          // Blob store cap for a single upload. Matches the largest media any
          // connected platform accepts in practice; the platforms themselves
          // enforce their own stricter limits at publish time.
          maximumSizeInBytes: 512 * 1024 * 1024,
          tokenPayload: JSON.stringify({
            userId: user.id,
            uploadedAt: new Date().toISOString(),
          }),
        };
      },
      onUploadCompleted: async ({ blob }) => {
        logger.info("[Upload] Upload completed", { url: blob.url });
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    logger.error("[Upload] Error", { error });
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }
}
