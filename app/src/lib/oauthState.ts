import crypto from "crypto";

import type { ConnectLinkFlow } from "./connectLink";

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET must be set to use OAuth state helpers.");
  }
  return secret;
}

/**
 * Team Workspaces (design §5): the OAuth state now carries the workspace the
 * caller was gated into at `/start` time (an owner of `workspaceId`), so the
 * callback can re-verify ownership without a separate DB round trip to
 * "resolve" a workspace for the user.
 */
export interface OAuthStatePayload {
  userId: string;
  workspaceId: string;
}

export function createOAuthState({ userId, workspaceId }: OAuthStatePayload): string {
  const payload = JSON.stringify({ userId, workspaceId, ts: Date.now() });
  const secret = getSecret();

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  const signature = hmac.digest("hex");

  const wrapped = JSON.stringify({ p: payload, s: signature });
  return Buffer.from(wrapped, "utf8").toString("base64url");
}

export type OAuthStateCheck = { valid: boolean; userId?: string; workspaceId?: string };

/**
 * `link` null (or left out): today's check of an ordinary state, unchanged. A
 * link state never passes it, because it is signed with another key. With a
 * link: only that link's own state passes (same link id and nonce), and the
 * answer is its creator's user id and the link's workspace.
 */
export function verifyOAuthState(state: string, link: ConnectLinkFlow | null = null): OAuthStateCheck {
  if (link) return verifyConnectLinkState(state, link);
  return verifyOrdinaryState(state);
}

function verifyOrdinaryState(state: string): OAuthStateCheck {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as { p: string; s: string };
    if (!parsed?.p || !parsed?.s) {
      return { valid: false };
    }

    const secret = getSecret();
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(parsed.p);
    const expectedSignature = hmac.digest("hex");

    if (parsed.s.length !== expectedSignature.length) {
      return { valid: false };
    }

    const a = Buffer.from(parsed.s, "utf8");
    const b = Buffer.from(expectedSignature, "utf8");
    if (!crypto.timingSafeEqual(a, b)) {
      return { valid: false };
    }

    const data = JSON.parse(parsed.p) as { userId: string; workspaceId: string; ts: number };
    // workspaceId is REQUIRED (Team Workspaces). A pre-workspaces state has no
    // workspaceId at all; this also rejects an empty-string value. Old-format
    // states fail closed here rather than resolving to `workspaceId:
    // undefined` — safe because the 10-minute TTL already makes a
    // deploy-boundary mismatch a non-event (the in-flight state just dies).
    if (!data?.userId || !data?.workspaceId || typeof data.ts !== "number") {
      return { valid: false };
    }

    if (Date.now() - data.ts > STATE_MAX_AGE_MS) {
      return { valid: false };
    }

    return { valid: true, userId: data.userId, workspaceId: data.workspaceId };
  } catch {
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// Client connect link (2026-11-11). A flow started from /c/<token> carries its
// own state: the creator's user id, the workspace, the link id and a nonce that
// is also in the visitor's sealed cookie. It is signed with a key derived from
// the secret and wrapped with a marker, so verifyOrdinaryState (and the code
// released before the link existed) answers invalid for it.
// ---------------------------------------------------------------------------

const LINK_STATE_MARKER = "cl1";

export interface ConnectLinkStatePayload {
  linkId: string;
  nonce: string;
  userId: string;
  workspaceId: string;
}

function linkStateKey(): Buffer {
  return crypto.createHmac("sha256", getSecret()).update("vibesocials connect-link oauth state v1").digest();
}

function signLinkPayload(payload: string): string {
  return crypto.createHmac("sha256", linkStateKey()).update(payload).digest("hex");
}

export function createConnectLinkState({ linkId, nonce, userId, workspaceId }: ConnectLinkStatePayload): string {
  const payload = JSON.stringify({ linkId, nonce, userId, workspaceId, ts: Date.now() });
  const wrapped = JSON.stringify({ k: LINK_STATE_MARKER, p: payload, s: signLinkPayload(payload) });
  return Buffer.from(wrapped, "utf8").toString("base64url");
}

function decodeEnvelope(state: string): { k?: unknown; p?: unknown; s?: unknown } | null {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as { k?: unknown; p?: unknown; s?: unknown }) : null;
  } catch {
    return null;
  }
}

/** Whether a state is in the link envelope at all; says nothing about its signature. */
export function looksLikeConnectLinkState(state: string): boolean {
  return decodeEnvelope(state)?.k === LINK_STATE_MARKER;
}

/** The signed contents of an unexpired link state, or null for anything else. */
export function readConnectLinkState(state: string): ConnectLinkStatePayload | null {
  try {
    const envelope = decodeEnvelope(state);
    if (!envelope || envelope.k !== LINK_STATE_MARKER) return null;
    if (typeof envelope.p !== "string" || typeof envelope.s !== "string") return null;

    const expected = signLinkPayload(envelope.p);
    if (envelope.s.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(envelope.s, "utf8"), Buffer.from(expected, "utf8"))) return null;

    const data = JSON.parse(envelope.p) as Partial<ConnectLinkStatePayload> & { ts?: unknown };
    if (!data?.linkId || !data.nonce || !data.userId || !data.workspaceId || typeof data.ts !== "number") {
      return null;
    }
    if (Date.now() - data.ts > STATE_MAX_AGE_MS) return null;

    return { linkId: data.linkId, nonce: data.nonce, userId: data.userId, workspaceId: data.workspaceId };
  } catch {
    return null;
  }
}

function verifyConnectLinkState(state: string, link: ConnectLinkFlow): OAuthStateCheck {
  const data = readConnectLinkState(state);
  if (
    !data ||
    data.linkId !== link.id ||
    data.nonce !== link.nonce ||
    data.userId !== link.userId ||
    data.workspaceId !== link.workspaceId
  ) {
    return { valid: false };
  }
  return { valid: true, userId: data.userId, workspaceId: data.workspaceId };
}
