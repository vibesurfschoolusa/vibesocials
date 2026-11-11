import { adminNotFoundResponse } from "@/lib/operator";

/**
 * Every API path that matches no route (fix round 1, 2026-11-10). Without this,
 * Next answers an unknown /api path with its HTML 404 page while a refused admin
 * route answers adminNotFoundResponse()'s JSON, so a customer could tell an
 * admin route exists. Now both give the same status, body and content type.
 *
 * Precedence: Next matches static segments first, then dynamic ones, then
 * catch-alls, and a deeper match beats a shallower one. Every existing route
 * under /api starts with a static segment (auth, posts, admin, ...) and is
 * therefore more specific than this root catch-all, including the
 * api/auth/[...nextauth] catch-all, whose static "auth" segment matches first.
 * Only a path no other route matches reaches this file.
 */
export const dynamic = "force-dynamic";

async function notFound() {
  return adminNotFoundResponse();
}

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
