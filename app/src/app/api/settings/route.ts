import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const COMPANY_WEBSITE_MAX_LENGTH = 2048;
export const DEFAULT_HASHTAGS_MAX_LENGTH = 1024;

export interface ParsedSettingsInput {
  companyWebsite: string | null;
  defaultHashtags: string | null;
}

export type SettingsValidationResult =
  | { ok: true; data: ParsedSettingsInput }
  | { ok: false; error: string };

/**
 * Validate a single optional string field from an unknown parsed JSON body.
 *
 * - Missing (`undefined`) or explicit `null` is valid and normalizes to `null`.
 * - Any non-string, non-null/undefined value (number, boolean, object, array)
 *   is rejected.
 * - The value is trimmed; a value that is empty or whitespace-only after
 *   trimming normalizes to `null` (matches the pre-existing `field || null`
 *   persistence behavior for falsy input).
 * - A trimmed value longer than `maxLength` is rejected.
 */
function validateOptionalString(
  value: unknown,
  fieldName: string,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: null };
  }

  if (typeof value !== "string") {
    return { ok: false, error: `${fieldName} must be a string` };
  }

  const trimmed = value.trim();

  if (trimmed.length > maxLength) {
    return {
      ok: false,
      error: `${fieldName} must be ${maxLength} characters or fewer`,
    };
  }

  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

/**
 * Validate + normalize an `unknown` parsed JSON body into the two known
 * settings fields (`companyWebsite`, `defaultHashtags`). Any other top-level
 * fields present on the body are ignored, not rejected.
 *
 * Exported (and kept a pure function of its input) so it can be unit tested
 * directly without exercising the HTTP handler.
 */
export function parseSettingsInput(body: unknown): SettingsValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const record = body as Record<string, unknown>;

  const companyWebsite = validateOptionalString(
    record.companyWebsite,
    "companyWebsite",
    COMPANY_WEBSITE_MAX_LENGTH,
  );
  if (!companyWebsite.ok) {
    return { ok: false, error: companyWebsite.error };
  }

  const defaultHashtags = validateOptionalString(
    record.defaultHashtags,
    "defaultHashtags",
    DEFAULT_HASHTAGS_MAX_LENGTH,
  );
  if (!defaultHashtags.ok) {
    return { ok: false, error: defaultHashtags.error };
  }

  return {
    ok: true,
    data: {
      companyWebsite: companyWebsite.value,
      defaultHashtags: defaultHashtags.value,
    },
  };
}

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const validation = parseSettingsInput(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        companyWebsite: validation.data.companyWebsite,
        defaultHashtags: validation.data.defaultHashtags,
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("[POST /api/settings] Error", { error });
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
