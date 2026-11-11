import { NextResponse } from "next/server";

import { getCurrentUser } from "./auth";
import { normalizeEmail } from "./email";
import { checkRateLimit } from "./rateLimit";

/**
 * The app's operator (2026-11-10): the people who may open /admin. This file is
 * the only gate; every admin page and route calls getOperator (directly or
 * through requireOperator) before anything else. Being an operator gives
 * nothing inside a workspace: getWorkspaceContext does not know about it.
 */

export type Operator = { userId: string; email: string };

/** ADMIN_EMAILS as a set: comma-separated, trimmed, lower-cased, empties dropped. */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => normalizeEmail(entry))
      .filter((entry) => entry.length > 0),
  );
}

/**
 * Whether this user is an operator: their email, trimmed and lower-cased, is in
 * ADMIN_EMAILS and it is verified. Registration is open and sign-in does not
 * require verification, so without the second condition anyone could register
 * an operator's address before the operator does. Pure: no session, no
 * database, so a caller that already holds the user (GET /api/workspaces) pays
 * nothing and cannot fail on it.
 */
export function isOperatorUser(
  user: { email: string; emailVerifiedAt: Date | null },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!user.emailVerifiedAt) return false;
  return parseAdminEmails(env.ADMIN_EMAILS).has(normalizeEmail(user.email));
}

/**
 * The signed-in operator, or null. ADMIN_EMAILS is read at request time, so a
 * change needs no restart; with it unset or empty the session is never read.
 */
export async function getOperator(): Promise<Operator | null> {
  if (parseAdminEmails(process.env.ADMIN_EMAILS).size === 0) return null;

  const user = await getCurrentUser();
  if (!user || !isOperatorUser(user)) return null;
  return { userId: user.id, email: normalizeEmail(user.email) };
}

/** What a missing API route answers. Every refusal of a non-operator is exactly this. */
export function adminNotFoundResponse(): NextResponse {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

/** Per operator, per hour; fails closed, since these routes cross every workspace. */
export const ADMIN_RATE_LIMITS = {
  read: { route: "admin/read", limit: 120, windowMs: 60 * 60 * 1000 },
  change: { route: "admin/change", limit: 30, windowMs: 60 * 60 * 1000 },
} as const;

export type AdminRequestKind = keyof typeof ADMIN_RATE_LIMITS;

/** Counts one admin request against the operator's hourly budget. */
export async function checkAdminRateLimit(
  operator: Operator,
  kind: AdminRequestKind,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  return checkRateLimit({ userId: operator.userId, ...ADMIN_RATE_LIMITS[kind], failClosed: true });
}

/**
 * For an admin route: the operator, or the response to return as-is. A
 * non-operator gets the plain 404 before any rate-limit write, so nothing about
 * them differs from a request to a route that does not exist.
 */
export async function requireOperator(kind: AdminRequestKind): Promise<Operator | NextResponse> {
  const operator = await getOperator();
  if (!operator) return adminNotFoundResponse();

  const limit = await checkAdminRateLimit(operator, kind);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many admin requests this hour. Wait and try again.", retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds ?? 60) } },
    );
  }
  return operator;
}

/**
 * Every other method of an admin route. Without these, Next answers 405 (and
 * OPTIONS answers 204 with an Allow header), which would tell anyone the path
 * exists. Each route module re-exports the ones it does not implement.
 */
export const adminOtherMethods = {
  GET: async () => adminNotFoundResponse(),
  POST: async () => adminNotFoundResponse(),
  PUT: async () => adminNotFoundResponse(),
  PATCH: async () => adminNotFoundResponse(),
  DELETE: async () => adminNotFoundResponse(),
  OPTIONS: async () => adminNotFoundResponse(),
};
