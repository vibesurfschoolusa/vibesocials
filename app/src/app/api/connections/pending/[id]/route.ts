import { NextResponse } from "next/server";

import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { requireOwnerContext, type WorkspaceContext } from "@/lib/workspace";
import {
  connectPendingCandidate,
  deletePendingConnection,
  listPendingCandidates,
  loadPendingConnection,
} from "@/server/connections/pendingConnection";

interface PendingRouteContext {
  params: Promise<{ id: string }>;
}

/**
 * /api/connections/pending/[id] — a Facebook, Instagram or LinkedIn connect
 * that found several accounts and is waiting for the user to choose one
 * (server/connections/pendingConnection.ts). The OAuth callback sends the user
 * to `/settings?choose=<id>`; the Settings dialog drives these.
 *
 * Owner-only, like every connect. A pending connect is visible only to the
 * user who started it, in the workspace it was started for, while it is
 * unexpired: anything else is a 404.
 */

function notFound(): NextResponse {
  return NextResponse.json(
    { error: "This choice expired. Connect again." },
    { status: 404 },
  );
}

function ownerOf(context: WorkspaceContext) {
  return { workspaceId: context.workspace.id, userId: context.user.id };
}

/**
 * The error's kind only. A POST failure can come from the connection upsert,
 * and a Prisma validation error quotes the call's arguments: the tokens.
 */
function errorKind(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "unknown" };
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? { name: error.name, code } : { name: error.name };
}

/** GET → `{ platform, candidates: [{ id, name, detail? }] }`. Never tokens. */
export async function GET(_request: Request, { params }: PendingRouteContext) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }

  const { id } = await params;

  try {
    const pending = await loadPendingConnection(id, ownerOf(contextOrError));
    if (!pending) {
      return notFound();
    }

    return NextResponse.json({
      platform: pending.platform,
      candidates: listPendingCandidates(pending.payload),
    });
  } catch (error) {
    logger.error("[GET /api/connections/pending/[id]] Unexpected error", {
      error,
      pendingConnectionId: id,
    });
    return NextResponse.json({ error: "Failed to load the accounts." }, { status: 500 });
  }
}

/**
 * POST { candidateId } → connects that account exactly as the OAuth callback
 * connects a lone one, deletes the pending connect, and answers
 * `{ ok: true, platform }`.
 */
export async function POST(request: Request, { params }: PendingRouteContext) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }

  const rateLimit = await checkRateLimit({
    userId: contextOrError.user.id,
    route: "connections/pending",
    limit: 30,
    windowMs: 5 * 60 * 1000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down.", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 1) } },
    );
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }

  const { candidateId } = body;
  if (typeof candidateId !== "string" || !candidateId) {
    return NextResponse.json({ error: "candidateId is required." }, { status: 400 });
  }

  const { id } = await params;
  const owner = ownerOf(contextOrError);

  try {
    const pending = await loadPendingConnection(id, owner);
    if (!pending) {
      return notFound();
    }

    const result = await connectPendingCandidate(pending, candidateId, owner);
    if (!result.ok) {
      return result.reason === "unknown_candidate"
        ? NextResponse.json(
            { error: "That account isn't one of the choices." },
            { status: 400 },
          )
        : NextResponse.json(
            { error: "Couldn't load that account from the platform. Please try again." },
            { status: 502 },
          );
    }

    await deletePendingConnection(pending.id);

    return NextResponse.json({ ok: true, platform: pending.platform });
  } catch (error) {
    logger.error("[POST /api/connections/pending/[id]] Unexpected error", {
      error: errorKind(error),
      pendingConnectionId: id,
    });
    return NextResponse.json({ error: "Failed to connect the account." }, { status: 500 });
  }
}

/** DELETE → cancels the pending connect. */
export async function DELETE(_request: Request, { params }: PendingRouteContext) {
  const contextOrError = await requireOwnerContext();
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }

  const { id } = await params;

  try {
    const pending = await loadPendingConnection(id, ownerOf(contextOrError));
    if (!pending) {
      return notFound();
    }

    await deletePendingConnection(pending.id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[DELETE /api/connections/pending/[id]] Unexpected error", {
      error,
      pendingConnectionId: id,
    });
    return NextResponse.json({ error: "Failed to cancel." }, { status: 500 });
  }
}
