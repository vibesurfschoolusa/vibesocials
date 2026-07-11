import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";

export const COMPANY_WEBSITE_MAX_LENGTH = 2048;
export const DEFAULT_HASHTAGS_MAX_LENGTH = 1024;
// Roadmap Phase 6: matches the Prisma schema's `@default(true)` so an omitted
// field behaves the same at the API layer as a never-touched DB row.
export const NOTIFY_ON_POST_COMPLETE_DEFAULT = true;

export interface ParsedSettingsInput {
  companyWebsite: string | null;
  defaultHashtags: string | null;
  notifyOnPostComplete: boolean;
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
 * Validate a single boolean field from an unknown parsed JSON body.
 *
 * - Missing (`undefined`) or explicit `null` is valid and normalizes to
 *   `defaultValue` (mirrors `validateOptionalString`'s missing-is-valid
 *   leniency, adapted for a non-nullable DB column: there is no `null` to
 *   normalize to, so a missing field falls back to the schema's own default).
 * - Any non-boolean value (string, number, object, array) is rejected.
 */
function validateBoolean(
  value: unknown,
  fieldName: string,
  defaultValue: boolean,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: defaultValue };
  }

  if (typeof value !== "boolean") {
    return { ok: false, error: `${fieldName} must be a boolean` };
  }

  return { ok: true, value };
}

/**
 * Validate + normalize an `unknown` parsed JSON body into the known settings
 * fields (`companyWebsite`, `defaultHashtags`, `notifyOnPostComplete`). Any
 * other top-level fields present on the body are ignored, not rejected.
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

  const notifyOnPostComplete = validateBoolean(
    record.notifyOnPostComplete,
    "notifyOnPostComplete",
    NOTIFY_ON_POST_COMPLETE_DEFAULT,
  );
  if (!notifyOnPostComplete.ok) {
    return { ok: false, error: notifyOnPostComplete.error };
  }

  return {
    ok: true,
    data: {
      companyWebsite: companyWebsite.value,
      defaultHashtags: defaultHashtags.value,
      notifyOnPostComplete: notifyOnPostComplete.value,
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

  // NOTE (review Minor #1): this is a FULL-REPLACE endpoint. An omitted field is
  // normalized to its default (null / schema default), so a partial body would
  // reset unsent fields — e.g. a POST without `notifyOnPostComplete` re-opts the
  // user IN. The sole caller (settings-form.tsx) always sends all three fields,
  // so this is latent; any NEW caller must send the complete settings object (or
  // switch this to partial/merge semantics before adding one).
  try {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        companyWebsite: validation.data.companyWebsite,
        defaultHashtags: validation.data.defaultHashtags,
        notifyOnPostComplete: validation.data.notifyOnPostComplete,
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
