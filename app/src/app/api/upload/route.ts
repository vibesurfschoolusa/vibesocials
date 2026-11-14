import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

import { UPLOAD_PATH_REFUSED_MESSAGE, isSignedInUploadKey } from "@/lib/blobKey";
import { coverUploadRefusal, isWorkspaceCoverAddress } from "@/lib/coverBlobPath";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { UPLOAD_ALLOWED_CONTENT_TYPES } from "@/lib/mediaInput";
import { checkRateLimit } from "@/lib/rateLimit";
import { getWorkspaceContext } from "@/lib/workspace";
import { logoAddressRefusal } from "@/lib/workspaceLogo";
import { accessBlockResponse } from "@/lib/workspaceStatus";
import { checkStorageLimit } from "@/server/usage/workspaceUsage";

import {
  UPLOAD_BYTES_LIMIT_MESSAGE,
  consumeUploadDayBytes,
  declaredUploadSize,
  releaseUploadDayBytes,
} from "./uploadBudget";

/**
 * GET /api/upload — why the active workspace cannot upload, if it cannot.
 * `upload()` from @vercel/blob/client drops the body of a refused token request
 * and throws a generic error, so Create and the Media page ask here to show the
 * storage sentence instead (lib/uploadFailure.ts).
 */
/**
 * R2 M1: the only pathnames a signed-in token is signed for: a generateBlobKey
 * upload at the root, or a cover in the active workspace's own covers/ folder.
 * Both are shapes the orphan sweep lists and deletes when nothing refers to
 * them, so no token can park a file where it would never be counted or swept.
 */
function isSignablePathname(pathname: string, workspaceId: string): boolean {
  return isSignedInUploadKey(pathname) || isWorkspaceCoverAddress(pathname, workspaceId);
}

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
  const blocked = accessBlockResponse(context);
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

  // R2 M1: the bytes this token request counted against the person's day, given
  // back when signing then fails. The same size is the token's maximum.
  let countedBytes = 0;

  // Usage limits (2026-11-10): no new token once the workspace's media is at or
  // over its storage limit. Checked before the file exists, so one upload can
  // take it over the limit; that is accepted.
  if (body.type === "blob.generate-client-token") {
    // logos/ holds the server's own workspace logos (lib/workspaceLogo.ts):
    // no client token may write there.
    const payload = body.payload as { pathname?: unknown; clientPayload?: unknown } | null | undefined;
    const pathname = payload && typeof payload.pathname === "string" ? payload.pathname : "";
    const logoRefusal = logoAddressRefusal(pathname);
    if (logoRefusal) {
      return NextResponse.json({ error: logoRefusal }, { status: 400 });
    }
    // V1 fix round 1: covers/<workspaceId>/ is that workspace's own; POST
    // /api/posts takes a cover only from the poster's folder.
    const coverRefusal = coverUploadRefusal(pathname, context.workspace.id);
    if (coverRefusal) {
      return NextResponse.json({ error: coverRefusal }, { status: 400 });
    }
    if (!isSignablePathname(pathname, context.workspace.id)) {
      return NextResponse.json({ error: UPLOAD_PATH_REFUSED_MESSAGE }, { status: 400 });
    }
    const declared = declaredUploadSize(payload?.clientPayload);
    if (!declared.ok) {
      return NextResponse.json({ error: declared.error }, { status: 400 });
    }
    const refusal = await checkStorageLimit(context.workspace.id);
    if (refusal) {
      return NextResponse.json({ error: refusal.error, code: refusal.code }, { status: 403 });
    }
    const day = await consumeUploadDayBytes(user.id, declared.size);
    if (!day.allowed) {
      return NextResponse.json(
        { error: UPLOAD_BYTES_LIMIT_MESSAGE, retryAfterSeconds: day.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(day.retryAfterSeconds ?? 60) } },
      );
    }
    countedBytes = declared.size;
  }

  try {
    const jsonResponse = await handleUpload({
      body: body as unknown as HandleUploadBody,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        // Belt and braces: the checks above read the same body fields.
        if (!isSignablePathname(pathname, context.workspace.id)) {
          throw new Error(UPLOAD_PATH_REFUSED_MESSAGE);
        }
        const declared = declaredUploadSize(clientPayload);
        if (!declared.ok || declared.size !== countedBytes) {
          throw new Error(declared.ok ? "The upload's size changed while it was signed." : declared.error);
        }
        logger.info("[Upload] Generating token", { pathname, userId: user.id });

        return {
          allowedContentTypes: [...UPLOAD_ALLOWED_CONTENT_TYPES],
          // The declared size, at most 512 MB (declaredUploadSize): the store
          // refuses a larger file, so what was counted is what can be stored.
          maximumSizeInBytes: declared.size,
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
    if (countedBytes > 0) await releaseUploadDayBytes(user.id, countedBytes);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 400 },
    );
  }
}
