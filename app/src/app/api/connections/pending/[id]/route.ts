import { NextResponse } from "next/server";
import type { Platform } from "@prisma/client";

import { accountCheckFailedMessage, choiceDifferentAccountMessage } from "@/lib/differentAccount";
import { CONNECTION_EXPIRY_SELECT, inExpiryWarningWindow } from "@/lib/connectionExpiry";
import { prisma } from "@/lib/db";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { shownControl, signInButton } from "@/lib/oauthResult";
import { choiceFailedText, type ChoiceCardButton } from "@/lib/pendingChoiceText";
import { PLATFORM_LABELS } from "@/lib/platforms";
import { checkRateLimit } from "@/lib/rateLimit";
import { tooManyTriesResponse } from "@/lib/tooManyTries";
import { requireOwnerContext, type WorkspaceContext } from "@/lib/workspace";
import { renderedWorkspaceRefusal, sentWorkspaceId } from "@/lib/workspaceChanged";
import {
  connectPendingCandidate,
  deletePendingConnection,
  listPendingCandidates,
  loadPendingConnection,
} from "@/server/connections/pendingConnection";
import { connectedWasOffered, pendingSignInEndsSoon } from "@/server/connections/choiceOutcome";

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
 * unexpired: anything else is a 404. POST and DELETE also carry
 * `{ workspaceId }`, the workspace the Settings page was rendered for (F3), so
 * a stale tab is told to reload instead of "This choice expired".
 */

/** The platforms whose connect can end in a choice (server/connections/pendingConnection.ts). */
const CHOOSABLE = ["facebook_page", "instagram", "linkedin", "pinterest"] as const;

/**
 * R29 (as /c, client-journey L3): the choice is gone, expired or already
 * used (maybe on a press whose answer was lost), and its row is deleted
 * either way. The dialog passes `?platform=` once known; the sentence
 * follows the row Settings shows for it (shownControl): connected, or the
 * button that row offers. Without a platform it names no button. Only the
 * caller's own workspace's connection is read, and only an owner gets here.
 */
async function notFound(request: Request, id: string, owner: { workspaceId: string; userId: string }): Promise<NextResponse> {
  // R30 (security-billing L1): the hint outlives a reload, and the choice
  // belongs to the workspace it was started in, so a choice of this user's in
  // another workspace says so before this workspace's row is read. Switching
  // back drops ?choose= (afterWorkspaceChange), so the step is that card's
  // sign-in button (R31 platform-clients L1).
  const choice = await prisma.pendingConnection.findUnique({
    where: { id },
    select: { workspaceId: true, userId: true, expiresAt: true, platform: true },
  });
  if (choice && choice.userId === owner.userId && choice.workspaceId !== owner.workspaceId) {
    const step = await otherWorkspaceStep(choice.workspaceId, owner.userId, choice.platform);
    const error =
      choice.expiresAt.getTime() <= Date.now()
        ? `This choice, started in another workspace, expired. Switch back to it and ${step}.`
        : `This choice was started in another workspace. Switch back to it and ${step}.`;
    return NextResponse.json({ error }, { status: 404 });
  }
  const { workspaceId } = owner;
  const hint = new URL(request.url).searchParams.get("platform");
  const platform = CHOOSABLE.find((choosable) => choosable === hint);
  if (!platform) {
    return NextResponse.json(
      { error: "This choice has ended: it expired, or an account was already chosen. Close this to see your connections." },
      { status: 404 },
    );
  }
  const row = await prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId, platform } },
    select: CONNECTION_EXPIRY_SELECT,
  });
  const label = PLATFORM_LABELS[platform];
  const shown = shownControl(row ? { needsReconnect: row.needsReconnect, reconnectSoon: inExpiryWarningWindow(row) } : null);
  if (shown === "connected") {
    return NextResponse.json({ error: `This choice was already used: ${label} is connected.`, connected: true }, { status: 404 });
  }
  return NextResponse.json(
    {
      error:
        shown === "reconnect"
          ? `This choice has ended: it expired, or an account was already chosen. To choose again, press Reconnect on ${label}.`
          : `This choice expired. To start again, press Connect on ${label}.`,
    },
    { status: 404 },
  );
}

/** The sign-in button `platform`'s card shows in `workspaceId` (shownControl), or null for a working card. Throws on a failed read. */
async function cardButton(workspaceId: string, platform: Platform): Promise<"Connect" | "Reconnect" | null> {
  const row = await prisma.socialConnection.findUnique({
    where: { workspaceId_platform: { workspaceId, platform } },
    select: CONNECTION_EXPIRY_SELECT,
  });
  return signInButton(shownControl(row ? { needsReconnect: row.needsReconnect, reconnectSoon: inExpiryWarningWindow(row) } : null));
}

/**
 * R31 follow-up: the load failed. Reloading reads the same choice again; when
 * the dialog named the platform and its card can be read, starting over with
 * the card's button is the other way.
 */
async function loadFailedText(request: Request, workspaceId: string): Promise<string> {
  const card = await hintedCardButton(request, workspaceId);
  return card
    ? `Couldn't load your accounts. Reload the page to try again, or close this and press ${card.button} on ${card.label}.`
    : LOAD_FAILED_MESSAGE;
}

/** The button the dialog's platform (`?platform=`) shows on its card, or null when none is named or it can't be read. */
async function hintedCardButton(request: Request, workspaceId: string): Promise<ChoiceCardButton | null> {
  const hint = new URL(request.url).searchParams.get("platform");
  const platform = CHOOSABLE.find((choosable) => choosable === hint);
  if (!platform) return null;
  try {
    const button = await cardButton(workspaceId, platform);
    return button ? { button, label: PLATFORM_LABELS[platform] } : null;
  } catch {
    return null;
  }
}

/**
 * R31 (platform-clients L1): what to press on the choice's platform card in
 * its own workspace, read there only while this user is still an owner
 * there: the button that card shows (shownControl). A working card shows
 * neither, and a read that fails says nothing, so then no button is named.
 * Lower case, no full stop.
 */
async function otherWorkspaceStep(workspaceId: string, userId: string, platform: Platform): Promise<string> {
  const label = PLATFORM_LABELS[platform];
  const noButton = `try again from the ${label} card there`;
  try {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (member?.role !== "owner") return noButton;
    const button = await cardButton(workspaceId, platform);
    return button ? `press ${button} on ${label} there` : noButton;
  } catch (error) {
    logger.warn("[pending/[id]] Couldn't read the other workspace's card (ignored)", { error: errorKind(error) });
    return noButton;
  }
}

/**
 * R37 lead follow-up: the owner gate reads the database and re-throws all but
 * "forbidden" (a member's 403 and the signed-out 401 come back as answers, as
 * before). A failure there was a bare 500, which the dialog reads as a lost
 * answer ("may have been connected"). Nothing was read or saved yet, so the
 * method's own sentence answers, as JSON. `method` names the log line only.
 */
async function ownerGate(method: string, failedText: string): Promise<WorkspaceContext | NextResponse> {
  try {
    return await requireOwnerContext();
  } catch (error) {
    logger.error(`[${method} /api/connections/pending/[id]] The owner check failed`, { error: errorKind(error) });
    return NextResponse.json({ error: failedText }, { status: 500 });
  }
}

const LOAD_FAILED_MESSAGE = "Couldn't load your accounts. Reload the page to try again.";

const CANCEL_FAILED_MESSAGE = "Couldn't cancel the choice just now. You can leave it: it ends by itself in 15 minutes.";

function ownerOf(context: WorkspaceContext) {
  return { workspaceId: context.workspace.id, userId: context.user.id };
}

/**
 * The error's kind only, for every method: a POST failure can come from the
 * connection upsert, and a Prisma validation error quotes the call's
 * arguments (the tokens); a payload parse error would quote the payload.
 */
function errorKind(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "unknown" };
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? { name: error.name, code } : { name: error.name };
}

/** GET → `{ platform, candidates: [{ id, name, detail? }] }`. Never tokens. */
export async function GET(request: Request, { params }: PendingRouteContext) {
  const contextOrError = await ownerGate("GET", LOAD_FAILED_MESSAGE);
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }

  // R32 publishing L1: the page's workspace, so a Settings tab left on another
  // one never lists this workspace's account choice.
  const workspaceRefusal = renderedWorkspaceRefusal(sentWorkspaceId(request), contextOrError.workspace.id);
  if (workspaceRefusal) return workspaceRefusal;

  const { id } = await params;

  try {
    const pending = await loadPendingConnection(id, ownerOf(contextOrError));
    if (!pending) {
      return await notFound(request, id, ownerOf(contextOrError));
    }

    return NextResponse.json({
      platform: pending.platform,
      candidates: listPendingCandidates(pending.payload),
    });
  } catch (error) {
    logger.error("[GET /api/connections/pending/[id]] Unexpected error", {
      error: errorKind(error),
      pendingConnectionId: id,
    });
    return NextResponse.json({ error: await loadFailedText(request, contextOrError.workspace.id) }, { status: 500 });
  }
}

/**
 * POST { candidateId } → connects that account exactly as the OAuth callback
 * connects a lone one, deletes the pending connect, and answers
 * `{ ok: true, platform }`.
 */
export async function POST(request: Request, { params }: PendingRouteContext) {
  // No workspace is known yet, so the before-save sentence names no card button.
  const contextOrError = await ownerGate("POST", choiceFailedText("before_save", "settings"));
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
    return tooManyTriesResponse(rateLimit);
  }

  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }
  const refusal = renderedWorkspaceRefusal(body.workspaceId, contextOrError.workspace.id);
  if (refusal) {
    return refusal;
  }

  const { candidateId } = body;
  if (typeof candidateId !== "string" || !candidateId) {
    return NextResponse.json({ error: "candidateId is required." }, { status: 400 });
  }

  const { id } = await params;
  const owner = ownerOf(contextOrError);

  // R36 review low 2 and second look, R37 pages L2: nothing is saved before
  // the choice is read, nor when the save is refused, so a failure there says
  // the account wasn't connected. "May have been connected" is only for the
  // save and after it (choiceFailedText).
  const failedBeforeSave = async (error: unknown) => {
    logger.error("[POST /api/connections/pending/[id]] Failed before anything was saved", {
      error: errorKind(error),
      pendingConnectionId: id,
    });
    const card = await hintedCardButton(request, owner.workspaceId);
    return NextResponse.json({ error: choiceFailedText("before_save", "settings", card) }, { status: 500 });
  };

  let pending: Awaited<ReturnType<typeof loadPendingConnection>>;
  try {
    pending = await loadPendingConnection(id, owner);
    if (!pending) {
      return await notFound(request, id, ownerOf(contextOrError));
    }
  } catch (error) {
    return failedBeforeSave(error);
  }

  let result: Awaited<ReturnType<typeof connectPendingCandidate>>;
  try {
    result = await connectPendingCandidate(pending, candidateId, owner);
  } catch (error) {
    logger.error("[POST /api/connections/pending/[id]] Unexpected error", {
      error: errorKind(error),
      pendingConnectionId: id,
    });
    // R31 new-customer L3: the save itself may have gone through.
    return NextResponse.json({ error: choiceFailedText("after_save", "settings") }, { status: 500 });
  }

  if (!result.ok) {
    try {
      return await refusedChoice(pending, result, owner.workspaceId);
    } catch (error) {
      return failedBeforeSave(error);
    }
  }

  // R31 new-customer L3: the account is saved; a failed clean-up must not
  // turn that into "failed". The row ends by itself (and the daily sweep
  // deletes it).
  await deletePendingConnection(pending.id).catch((error: unknown) => {
    logger.error("[POST /api/connections/pending/[id]] Couldn't delete the used choice (ignored)", {
      error: errorKind(error),
      pendingConnectionId: id,
    });
  });

  // R7 review 4: the dialog adds same_end to the success address, as the callback does.
  return NextResponse.json(
    pendingSignInEndsSoon(pending)
      ? { ok: true, platform: pending.platform, sameEnd: true }
      : { ok: true, platform: pending.platform },
  );
}

/** The answer to a save that was refused: nothing was connected, and the choice stays. */
async function refusedChoice(
  pending: NonNullable<Awaited<ReturnType<typeof loadPendingConnection>>>,
  result: Exclude<Awaited<ReturnType<typeof connectPendingCandidate>>, { ok: true }>,
  workspaceId: string,
): Promise<NextResponse> {
  if (result.reason === "check_failed") {
    return NextResponse.json({ error: accountCheckFailedMessage(result.connectedName) }, { status: 503 });
  }
  if (result.reason === "different_account") {
    // R6 review low 1: the connection stays as it was, and so does the choice.
    // R7 review 3: when the connected one was on the list, choosing it is the way.
    const offered = await connectedWasOffered(pending, workspaceId);
    return NextResponse.json(
      { error: choiceDifferentAccountMessage(pending.platform, result.signedInName, result.connectedName, offered) },
      { status: 409 },
    );
  }
  return result.reason === "unknown_candidate"
    ? NextResponse.json({ error: "That account isn't one of the choices." }, { status: 400 })
    : NextResponse.json({ error: "Couldn't load that account from the platform. Please try again." }, { status: 502 });
}

/** DELETE → cancels the pending connect. */
export async function DELETE(request: Request, { params }: PendingRouteContext) {
  const contextOrError = await ownerGate("DELETE", CANCEL_FAILED_MESSAGE);
  if (contextOrError instanceof NextResponse) {
    return contextOrError;
  }
  const refusal = renderedWorkspaceRefusal((await readJsonObject(request))?.workspaceId, contextOrError.workspace.id);
  if (refusal) {
    return refusal;
  }

  const { id } = await params;

  try {
    const pending = await loadPendingConnection(id, ownerOf(contextOrError));
    if (!pending) {
      return await notFound(request, id, ownerOf(contextOrError));
    }

    await deletePendingConnection(pending.id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    logger.error("[DELETE /api/connections/pending/[id]] Unexpected error", {
      error: errorKind(error),
      pendingConnectionId: id,
    });
    return NextResponse.json({ error: CANCEL_FAILED_MESSAGE }, { status: 500 });
  }
}
