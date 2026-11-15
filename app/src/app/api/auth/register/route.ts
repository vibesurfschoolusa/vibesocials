import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

import { buildVerifyEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { issueAccountToken } from "@/lib/accountToken";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { invalidJsonBodyResponse, readJsonObject } from "@/lib/http";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { provisionPersonalWorkspace } from "@/lib/workspace";
import { addressHeldUntil } from "@/server/auth/undoWindow";

const REGISTER_RATE_LIMIT = {
  route: "auth/register",
  limit: 5,
  windowMs: 60 * 60 * 1000,
} as const;

/**
 * R5 new-customer L5: the personal workspace is named "<name>'s workspace",
 * and a workspace name may be 60 characters (api/workspaces); "'s workspace"
 * takes 12 of them.
 */
const REGISTER_NAME_MAX_LENGTH = 48;

export async function POST(request: Request) {
  // IP throttle first (anonymous abuse surface). Fail closed on store errors so
  // a DB blip cannot open unlimited signup.
  const ip =
    (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim() ||
    "unknown";
  const rateLimit = await checkRateLimit({
    userId: `ip:${ip}`,
    ...REGISTER_RATE_LIMIT,
    failClosed: true,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: "Too many accounts created from this network. Please try again later.",
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds ?? 60) },
      },
    );
  }

  // Parsed outside the try below: a malformed body is a 400, not the 500 the
  // catch-all would turn a failed body parse into.
  const body = await readJsonObject(request);
  if (!body) {
    return invalidJsonBodyResponse();
  }

  // Parsed once so the outer catch can reuse email/name for the P2002
  // no-oracle response without re-reading the request body.
  let parsedEmail = "";
  let parsedDisplayName: string | null = null;

  try {
    const { email: rawEmail, password, name } = body;

    if (!rawEmail || !password) {
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 },
      );
    }

    if (typeof rawEmail !== "string" || !/^\S+@\S+\.\S+$/.test(rawEmail)) {
      return NextResponse.json(
        { error: "Enter a valid email address." },
        { status: 400 },
      );
    }
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 },
      );
    }

    // Cleaned the way a workspace name is, so stray spaces never reach the
    // workspace name ("Maria 's workspace").
    const cleanedName = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
    if (cleanedName.length > REGISTER_NAME_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Use a name of up to ${REGISTER_NAME_MAX_LENGTH} characters, or leave it empty.` },
        { status: 400 },
      );
    }

    const email = normalizeEmail(rawEmail);
    const displayName = cleanedName || null;
    parsedEmail = email;
    parsedDisplayName = displayName;

    // SEC-1 — no email-existence oracle. Body shape is identical for new and
    // existing accounts (never return a real user id — `id: "ok"` vs a cuid
    // would reintroduce an oracle). Client always attempts signIn next: a new
    // account signs in; an existing one only if the password matches.
    const registerOkBody = (emailValue: string, nameValue: string | null) => ({
      id: "ok" as const,
      email: emailValue,
      name: nameValue,
    });

    // R6-security M1: an address an email change replaced stays free for that
    // change's undo while it is open, so it answers as if the account existed.
    const existing =
      (await prisma.user.findUnique({ where: { email } })) || (await addressHeldUntil(prisma, email, new Date()));
    if (existing) {
      return NextResponse.json(registerOkBody(email, displayName), { status: 201 });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Registration creates the User and its personal workspace + owner
    // membership atomically (design doc §2), so a mid-way failure never
    // leaves a user without a workspace. (getWorkspaceContext's self-heal is
    // the backstop for pre-existing gaps, not the normal path.)
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: displayName,
          passwordHash,
        },
      });
      await provisionPersonalWorkspace(tx, created);
      return created;
    });

    // Fire-and-forget email verification. Runs AFTER the registration
    // transaction has COMMITTED and is fully failure-isolated: every path
    // (issuance or delivery) is caught and logged, so it can NEVER fail the
    // registration or turn a transient email hiccup into a 500. Gated on
    // RESEND_API_KEY so a deployment with email disabled issues no token at all
    // (mirrors deliverAccountEmail's own env gate; keeps the token table clean).
    try {
      if (process.env.RESEND_API_KEY) {
        const baseUrl = process.env.NEXTAUTH_URL ?? "";
        const rawToken = await issueAccountToken(prisma, user.id, "email_verify");
        await deliverAccountEmail(
          user.email,
          buildVerifyEmail({ to: user.email, rawToken, baseUrl }),
        );
      }
    } catch (error) {
      logger.warn("[register] verification email failed", { error });
    }

    return NextResponse.json(registerOkBody(user.email, user.name), { status: 201 });
  } catch (error) {
    // Unique-constraint race: two concurrent registers for the same email —
    // the loser would otherwise 500 and leak "email taken". Match the
    // no-oracle 201 shape used for the pre-create existence check.
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    if (code === "P2002") {
      return NextResponse.json(
        { id: "ok", email: parsedEmail, name: parsedDisplayName },
        { status: 201 },
      );
    }
    logger.error("[POST /api/auth/register] Unexpected error", { error });
    return NextResponse.json({ error: "We couldn't create your account just now. Nothing was saved. Please try again in a minute." }, { status: 500 });
  }
}
