import { NextResponse } from "next/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";

export const COMPANY_WEBSITE_MAX_LENGTH = 2048;
export const DEFAULT_HASHTAGS_MAX_LENGTH = 1024;
// Roadmap Phase 6: matches the Prisma schema's `@default(true)` so an omitted
// field behaves the same at the API layer as a never-touched DB row.
export const NOTIFY_ON_POST_COMPLETE_DEFAULT = true;
// Team Workspaces (Task 6, design §4). Mirrors WorkspaceForbiddenError's
// default message (src/lib/workspace.ts) for one consistent "you're not the
// owner" string app-wide. Duplicated rather than imported: this route's gate
// is CONDITIONAL (only the footer fields are owner-only — notifyOnPostComplete
// is open to any member), so it can't just delegate the whole route to
// requireOwnerContext()/WorkspaceForbiddenError the way the fully owner-gated
// routes do.
export const OWNER_ONLY_FOOTER_ERROR = "Only the workspace owner can do that.";

/**
 * Team Workspaces (Task 6, design §4): the caption footer moved to the
 * Workspace row (brand-level, owner-only); `notifyOnPostComplete` stays a
 * per-user preference. A key ABSENT from the request body is omitted from
 * `data` entirely — distinct from an explicit `null`, which normalizes to
 * "present, clear this field". This lets a partial request (e.g. a member
 * toggling only their notification preference) leave the fields it doesn't
 * mention untouched, instead of the old full-replace semantics.
 */
export interface ParsedSettingsInput {
  companyWebsite?: string | null;
  defaultHashtags?: string | null;
  notifyOnPostComplete?: boolean;
  /**
   * Approval workflow (2026-07-26). Workspace-level and OWNER-ONLY, same class
   * as the footer fields — it governs whether members' posts publish directly.
   */
  requireApproval?: boolean;
}

export type SettingsValidationResult =
  | { ok: true; data: ParsedSettingsInput }
  | { ok: false; error: string };

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Validate a present optional string field from an unknown parsed JSON body.
 * Only called when the field's key is present in the body (see `hasKey`
 * gating in `parseSettingsInput`) — absence is handled by the caller, not
 * this function.
 *
 * - An explicit `null` is valid and normalizes to `null` ("clear this field").
 * - Any non-string, non-null value (number, boolean, object, array) is
 *   rejected.
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
  if (value === null) {
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
 * Validate a present `notifyOnPostComplete` value. Only called when the key
 * is present in the body — absence is handled by the caller.
 *
 * - An explicit `null` is valid and normalizes to the schema default
 *   (`true`) — there's no meaningful "null" notification preference.
 * - Any non-boolean value (string, number, object, array) is rejected.
 */
function validateBoolean(
  value: unknown,
  fieldName: string,
): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === null) {
    return { ok: true, value: NOTIFY_ON_POST_COMPLETE_DEFAULT };
  }

  if (typeof value !== "boolean") {
    return { ok: false, error: `${fieldName} must be a boolean` };
  }

  return { ok: true, value };
}

/**
 * Validate + normalize an `unknown` parsed JSON body into the known settings
 * fields (`companyWebsite`, `defaultHashtags`, `notifyOnPostComplete`). Any
 * other top-level fields present on the body are ignored, not rejected. Only
 * keys ACTUALLY PRESENT in the body appear on the returned `data` — see
 * {@link ParsedSettingsInput}.
 *
 * Exported (and kept a pure function of its input) so it can be unit tested
 * directly without exercising the HTTP handler.
 */
export function parseSettingsInput(body: unknown): SettingsValidationResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }

  const record = body as Record<string, unknown>;
  const data: ParsedSettingsInput = {};

  if (hasKey(record, "companyWebsite")) {
    const result = validateOptionalString(
      record.companyWebsite,
      "companyWebsite",
      COMPANY_WEBSITE_MAX_LENGTH,
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    data.companyWebsite = result.value;
  }

  if (hasKey(record, "defaultHashtags")) {
    const result = validateOptionalString(
      record.defaultHashtags,
      "defaultHashtags",
      DEFAULT_HASHTAGS_MAX_LENGTH,
    );
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    data.defaultHashtags = result.value;
  }

  if (hasKey(record, "notifyOnPostComplete")) {
    const result = validateBoolean(record.notifyOnPostComplete, "notifyOnPostComplete");
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    data.notifyOnPostComplete = result.value;
  }

  if (hasKey(record, "requireApproval")) {
    // An explicit `null` normalizes to off — matching the schema default, same
    // convention validateBoolean uses for notifyOnPostComplete.
    if (record.requireApproval !== null && typeof record.requireApproval !== "boolean") {
      return { ok: false, error: "requireApproval must be a boolean" };
    }
    data.requireApproval = record.requireApproval === true;
  }

  return { ok: true, data };
}

/**
 * True when the parsed body attempts to touch either caption-footer field —
 * PRESENCE-based (a key in the request, even set to `null` to clear it), not
 * value-based. Gates the owner-only branch in `POST` below.
 */
export function touchesWorkspaceFooter(data: ParsedSettingsInput): boolean {
  return "companyWebsite" in data || "defaultHashtags" in data;
}

/**
 * True when the body touches ANY workspace-level, owner-only field: the caption
 * footer (above) or the approval flag. This is the gate for both the 403 and the
 * `workspace.update` branch in `POST`.
 */
export function touchesOwnerOnlyWorkspaceFields(data: ParsedSettingsInput): boolean {
  return touchesWorkspaceFooter(data) || "requireApproval" in data;
}

export async function POST(request: Request) {
  const context = await getWorkspaceContext();

  if (!context) {
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

  const { data } = validation;
  const updatesWorkspace = touchesOwnerOnlyWorkspaceFields(data);

  // Team Workspaces (Task 6, design §4): the caption footer is workspace
  // (brand) level and owner-only to change. A member request that touches
  // it is rejected WHOLESALE — no partial application of a notifyOnPostComplete
  // sent in the same body — simplest fail-closed behavior. Task 7 splits the
  // settings form so members never see footer inputs at all; until then, a
  // member submitting the (still-combined) form gets this 403.
  if (updatesWorkspace && context.role !== "owner") {
    return NextResponse.json({ error: OWNER_ONLY_FOOTER_ERROR }, { status: 403 });
  }

  try {
    if (updatesWorkspace) {
      const workspaceData: {
        companyWebsite?: string | null;
        defaultHashtags?: string | null;
        requireApproval?: boolean;
      } = {};
      if ("companyWebsite" in data) {
        workspaceData.companyWebsite = data.companyWebsite;
      }
      if ("defaultHashtags" in data) {
        workspaceData.defaultHashtags = data.defaultHashtags;
      }
      if ("requireApproval" in data) {
        workspaceData.requireApproval = data.requireApproval;
      }

      await prisma.workspace.update({
        where: { id: context.workspace.id },
        data: workspaceData,
      });
    }

    if ("notifyOnPostComplete" in data) {
      await prisma.user.update({
        where: { id: context.user.id },
        data: { notifyOnPostComplete: data.notifyOnPostComplete },
      });
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    logger.error("[POST /api/settings] Error", { error, userId: context.user.id });
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
