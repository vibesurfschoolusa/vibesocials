import crypto from "crypto";

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

export function verifyOAuthState(
  state: string,
): { valid: boolean; userId?: string; workspaceId?: string } {
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
