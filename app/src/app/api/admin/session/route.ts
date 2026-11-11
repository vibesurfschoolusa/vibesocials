import { NextResponse } from "next/server";

import { adminOtherMethods, requireOperator } from "@/lib/operator";

/**
 * GET /api/admin/session — whether the caller is an operator, for the account
 * menu's one "Admin" link. An operator gets `{ operator: true }`; anyone else
 * gets the plain 404 of a route that does not exist, so the menu shows nothing.
 */
export async function GET() {
  const operator = await requireOperator("read");
  if (operator instanceof NextResponse) return operator;
  return NextResponse.json({ operator: true });
}

export const POST = adminOtherMethods.POST;
export const PUT = adminOtherMethods.PUT;
export const PATCH = adminOtherMethods.PATCH;
export const DELETE = adminOtherMethods.DELETE;
export const OPTIONS = adminOtherMethods.OPTIONS;
