import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";

import { buildVerifyEmail, deliverAccountEmail } from "@/lib/accountEmails";
import { issueAccountToken } from "@/lib/accountToken";
import { prisma } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rateLimit";
import { provisionPersonalWorkspace } from "@/lib/workspace";

const REGISTER_RATE_LIMIT = {
  route: "auth/register",
  limit: 5,
  windowMs: 60 * 60 * 1000,
} as const;

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

  try {
    const body = await request.json();
    const { email: rawEmail, password, name } = body ?? {};

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

    const email = normalizeEmail(rawEmail);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: "A user with that email already exists." },
        { status: 400 },
      );
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
          name: name ?? null,
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

    return NextResponse.json(
      {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      { status: 201 },
    );
  } catch (error) {
    logger.error("[POST /api/auth/register] Unexpected error", { error });
    return NextResponse.json({ error: "Failed to register user." }, { status: 500 });
  }
}
