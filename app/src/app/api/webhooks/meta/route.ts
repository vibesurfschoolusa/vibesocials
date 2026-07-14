import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token &&
    challenge &&
    VERIFY_TOKEN &&
    token === VERIFY_TOKEN
  ) {
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

/**
 * Meta webhook receiver. When FACEBOOK_APP_SECRET is set, require a valid
 * X-Hub-Signature-256 HMAC over the raw body (Meta signed payloads).
 * Currently a no-op ack after verification — keep signature checks so future
 * side effects cannot ship without auth.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const secret = process.env.FACEBOOK_APP_SECRET?.trim();

  if (secret) {
    const signature = request.headers.get("x-hub-signature-256");
    if (!signature?.startsWith("sha256=")) {
      return NextResponse.json({ error: "Missing signature" }, { status: 403 });
    }
    const expected =
      "sha256=" +
      crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // In production without a secret, refuse POSTs so a misconfigured deploy
    // cannot accept unauthenticated webhook traffic if handlers gain effects.
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  return NextResponse.json({ received: true });
}
