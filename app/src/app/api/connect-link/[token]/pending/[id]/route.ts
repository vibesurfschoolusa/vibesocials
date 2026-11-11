import { NextResponse } from "next/server";

import {
  CONNECT_LINK_CHOICES_PER_HOUR,
  CONNECT_LINK_INACTIVE_MESSAGE,
  CONNECT_LINK_RATE_LIMIT_MESSAGE,
} from "@/lib/connectLink";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { PLATFORM_LABELS } from "@/lib/platforms";
import { checkRateLimit } from "@/lib/rateLimit";
import { requestIp } from "@/lib/uploadLink";
import { clearConnectCookie } from "@/server/connectLink/cookie";
import { findActiveConnectLink, placeTaken, type ActiveConnectLink } from "@/server/connectLink/link";
import {
  connectPendingCandidate,
  deletePendingConnection,
  listPendingCandidates,
  loadPendingConnection,
  type LoadedPendingConnection,
} from "@/server/connections/pendingConnection";

/**
 * /api/connect-link/[token]/pending/[id] — a connect-link flow that found
 * several accounts, waiting for the visitor to choose one on /c/[token]
 * (2026-11-11). Signed out: the token in the address names the link (rule 2),
 * and the row must be the creator's, in the link's workspace, unexpired AND
 * stamped with this link by the callback wrapper. A choice an owner started
 * in Settings, or another link's, is a 404 here. Answers as the owner's
 * /api/connections/pending/[id]; never a token.
 */

interface RouteContext {
  params: Promise<{ token: string; id: string }>;
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "This choice expired. Connect again." }, { status: 404 });
}

/** The error's kind only: a save failure's message can quote its arguments (the tokens). */
function errorKind(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "unknown" };
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? { name: error.name, code } : { name: error.name };
}

type Resolved =
  | { ok: true; link: ActiveConnectLink; pending: LoadedPendingConnection }
  | { ok: false; response: NextResponse };

async function resolve(request: Request, context: RouteContext): Promise<Resolved> {
  const limit = await checkRateLimit({
    userId: `ip:${requestIp(request)}`,
    route: "connect-link/pending",
    limit: CONNECT_LINK_CHOICES_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    failClosed: true,
  });
  if (!limit.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: CONNECT_LINK_RATE_LIMIT_MESSAGE, retryAfterSeconds: limit.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 60) } },
      ),
    };
  }

  const { token, id } = await context.params;
  const link = await findActiveConnectLink(token);
  if (!link) {
    return { ok: false, response: NextResponse.json({ error: CONNECT_LINK_INACTIVE_MESSAGE }, { status: 404 }) };
  }

  const stamp = await prisma.pendingConnection.findUnique({ where: { id }, select: { connectLinkId: true } });
  if (!stamp || stamp.connectLinkId !== link.id) return { ok: false, response: notFound() };

  const pending = await loadPendingConnection(id, { workspaceId: link.workspaceId, userId: link.createdById });
  if (!pending) return { ok: false, response: notFound() };
  return { ok: true, link, pending };
}

/** GET → `{ platform, candidates: [{ id, name, detail? }] }`. Never tokens. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const resolved = await resolve(request, context);
    if (!resolved.ok) return resolved.response;
    return NextResponse.json(
      { platform: resolved.pending.platform, candidates: listPendingCandidates(resolved.pending.payload) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    logger.error("[GET /api/connect-link/pending] Unexpected error", { error: errorKind(error) });
    return NextResponse.json({ error: "Failed to load the accounts." }, { status: 500 });
  }
}

/** POST { candidateId } → connects that account as the owner's route does, and answers `{ ok: true, platform }`. */
export async function POST(request: Request, context: RouteContext) {
  try {
    const resolved = await resolve(request, context);
    if (!resolved.ok) return resolved.response;
    const { link, pending } = resolved;

    const body = await readJsonObject(request);
    if (!body) return invalidJsonBodyResponse();
    const { candidateId } = body;
    if (typeof candidateId !== "string" || !candidateId) {
      return NextResponse.json({ error: "candidateId is required." }, { status: 400 });
    }

    // Rule 3, once more before the chosen account is saved.
    if (await placeTaken(link.workspaceId, pending.platform)) {
      return NextResponse.json(
        {
          error: `${PLATFORM_LABELS[pending.platform]} is already connected. Ask ${link.workspaceName} if it should be changed.`,
        },
        { status: 409 },
      );
    }

    const result = await connectPendingCandidate(pending, candidateId, {
      workspaceId: link.workspaceId,
      userId: link.createdById,
    });
    if (!result.ok) {
      return result.reason === "unknown_candidate"
        ? NextResponse.json({ error: "That account isn't one of the choices." }, { status: 400 })
        : NextResponse.json(
            { error: "Couldn't load that account from the platform. Please try again." },
            { status: 502 },
          );
    }

    await deletePendingConnection(pending.id);
    await prisma.workspaceConnectLink
      .update({ where: { id: link.id }, data: { lastUsedAt: new Date() } })
      .catch((error: unknown) => {
        logger.error("[connect-link] Couldn't record when the link was used (ignored)", {
          connectLinkId: link.id,
          error: errorKind(error),
        });
      });

    const response = NextResponse.json({ ok: true, platform: pending.platform });
    clearConnectCookie(response);
    return response;
  } catch (error) {
    logger.error("[POST /api/connect-link/pending] Unexpected error", { error: errorKind(error) });
    return NextResponse.json({ error: "Failed to connect the account." }, { status: 500 });
  }
}

/** DELETE → Cancel: drops the waiting choice. */
export async function DELETE(request: Request, context: RouteContext) {
  try {
    const resolved = await resolve(request, context);
    if (!resolved.ok) return resolved.response;
    await deletePendingConnection(resolved.pending.id);
    const response = NextResponse.json({ ok: true });
    clearConnectCookie(response);
    return response;
  } catch (error) {
    logger.error("[DELETE /api/connect-link/pending] Unexpected error", { error: errorKind(error) });
    return NextResponse.json({ error: "Failed to cancel." }, { status: 500 });
  }
}
