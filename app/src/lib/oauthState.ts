import crypto from "crypto";

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("NEXTAUTH_SECRET must be set to use OAuth state helpers.");
  }
  return secret;
}

export function createOAuthState(userId: string): string {
  const payload = JSON.stringify({ userId, ts: Date.now() });
  const secret = getSecret();

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  const signature = hmac.digest("hex");

  const wrapped = JSON.stringify({ p: payload, s: signature });
  return Buffer.from(wrapped, "utf8").toString("base64url");
}

export function verifyOAuthState(state: string): { valid: boolean; userId?: string } {
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

    const data = JSON.parse(parsed.p) as { userId: string; ts: number };
    if (!data?.userId || typeof data.ts !== "number") {
      return { valid: false };
    }

    if (Date.now() - data.ts > STATE_MAX_AGE_MS) {
      return { valid: false };
    }

    return { valid: true, userId: data.userId };
  } catch {
    return { valid: false };
  }
}
