import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";

/**
 * Google Business Profile post options (2026-11-10): a button, an event or an
 * offer. One pure validator for POST /api/posts, POST /api/settings (the
 * workspace's default button) and the composer's messages. It follows Google's
 * LocalPost reference: a CALL button has no link, an offer carries no button
 * (Google ignores callToAction for OFFER), and an event and an offer need a
 * title and dates. Google states no length limits, so the caps are our own.
 */

export type GoogleButton = NonNullable<GoogleBusinessPostMetadata["button"]>;
export type GoogleButtonType = GoogleButton["type"];
export type GooglePostType = GoogleBusinessPostMetadata["postType"];

export const GOOGLE_POST_TYPES: readonly GooglePostType[] = ["update", "event", "offer"];
export const GOOGLE_BUTTON_TYPES: readonly GoogleButtonType[] = [
  "BOOK",
  "ORDER",
  "SHOP",
  "LEARN_MORE",
  "SIGN_UP",
  "CALL",
];

export const GOOGLE_POST_TYPE_LABELS: Record<GooglePostType, string> = {
  update: "Update",
  event: "Event",
  offer: "Offer",
};

export const GOOGLE_BUTTON_LABELS: Record<GoogleButtonType, string> = {
  BOOK: "Book",
  ORDER: "Order online",
  SHOP: "Buy",
  LEARN_MORE: "Learn more",
  SIGN_UP: "Sign up",
  CALL: "Call now",
};

export const GOOGLE_TITLE_MAX = 58;
export const GOOGLE_COUPON_CODE_MAX = 58;
export const GOOGLE_TERMS_MAX = 5000;
export const GOOGLE_URL_MAX = 2048;

export type GoogleOptionsResult<T> = { ok: true; value: T } | { ok: false; error: string };

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A trimmed optional string; "" and absent are both undefined. */
function optionalText(value: unknown, label: string, max: number): GoogleOptionsResult<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (typeof value !== "string") return fail(`The ${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) {
    return fail(`The ${label} must be ${max.toLocaleString("en-US")} characters or fewer.`);
  }
  return { ok: true, value: trimmed || undefined };
}

function httpsLink(value: unknown, label: string, required: boolean): GoogleOptionsResult<string | undefined> {
  const text = optionalText(value, label, GOOGLE_URL_MAX);
  if (!text.ok) return text;
  if (text.value === undefined) {
    return required ? fail(`Add a ${label} that starts with https://.`) : text;
  }
  let parsed: URL;
  try {
    parsed = new URL(text.value);
  } catch {
    return fail(`The ${label} must start with https:// and be a full web address.`);
  }
  if (parsed.protocol !== "https:") {
    return fail(`The ${label} must start with https://.`);
  }
  return text;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isRealDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function requiredDate(value: unknown, label: string): GoogleOptionsResult<string> {
  if (typeof value !== "string" || !value.trim()) return fail(`Add the ${label}.`);
  const trimmed = value.trim();
  if (!isRealDate(trimmed)) return fail(`The ${label} must be a real date written YYYY-MM-DD.`);
  return { ok: true, value: trimmed };
}

function optionalTime(value: unknown, label: string): GoogleOptionsResult<string | undefined> {
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  if (typeof value !== "string" || !TIME_RE.test(value.trim())) {
    return fail(`The ${label} must be a time written HH:MM, from 00:00 to 23:59.`);
  }
  return { ok: true, value: value.trim() };
}

/** Title + start and end date, shared by an event and an offer. */
function titleAndDates(
  raw: Record<string, unknown>,
  kind: "event" | "offer",
): GoogleOptionsResult<{ title: string; startDate: string; endDate: string }> {
  const title = optionalText(raw.title, `${kind} title`, GOOGLE_TITLE_MAX);
  if (!title.ok) return title;
  if (!title.value) return fail(`Add the ${kind} title.`);
  const startDate = requiredDate(raw.startDate, `${kind} start date`);
  if (!startDate.ok) return startDate;
  const endDate = requiredDate(raw.endDate, `${kind} end date`);
  if (!endDate.ok) return endDate;
  // YYYY-MM-DD compares correctly as text.
  if (endDate.value < startDate.value) {
    return fail(`The ${kind} end date can't be before its start date.`);
  }
  return { ok: true, value: { title: title.value, startDate: startDate.value, endDate: endDate.value } };
}

/** A button, or null for none. A CALL button's link is dropped: Google wants it unset. */
export function parseGoogleButton(raw: unknown): GoogleOptionsResult<GoogleButton | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!isRecord(raw)) return fail("The Google button must be an object with a type and a link.");
  if (!GOOGLE_BUTTON_TYPES.includes(raw.type as GoogleButtonType)) {
    return fail(`The Google button type must be one of: ${GOOGLE_BUTTON_TYPES.join(", ")}.`);
  }
  const type = raw.type as GoogleButtonType;
  if (type === "CALL") return { ok: true, value: { type } };
  const url = httpsLink(raw.url, "button link", true);
  if (!url.ok) return url;
  return { ok: true, value: { type, url: url.value as string } };
}

/** Validate the request's `googleMetadata` into a clean object; unknown keys are dropped. */
export function parseGooglePostMetadata(raw: unknown): GoogleOptionsResult<GoogleBusinessPostMetadata> {
  if (!isRecord(raw)) return fail("googleMetadata must be an object.");
  if (!GOOGLE_POST_TYPES.includes(raw.postType as GooglePostType)) {
    return fail(`The Google post type must be one of: ${GOOGLE_POST_TYPES.join(", ")}.`);
  }
  const postType = raw.postType as GooglePostType;

  const button = parseGoogleButton(raw.button);
  if (!button.ok) return button;
  if (postType === "offer" && button.value) {
    return fail("A Google offer can't have a button. Choose No button, or make the post an update or an event.");
  }
  const withButton = button.value ? { button: button.value } : {};

  if (postType === "update") return { ok: true, value: { postType, ...withButton } };

  if (postType === "event") {
    if (!isRecord(raw.event)) return fail("Add the event's title and dates.");
    const base = titleAndDates(raw.event, "event");
    if (!base.ok) return base;
    const startTime = optionalTime(raw.event.startTime, "event start time");
    if (!startTime.ok) return startTime;
    const endTime = optionalTime(raw.event.endTime, "event end time");
    if (!endTime.ok) return endTime;
    if (
      base.value.startDate === base.value.endDate &&
      startTime.value &&
      endTime.value &&
      endTime.value < startTime.value
    ) {
      return fail("The event end time can't be before its start time on the same day.");
    }
    return {
      ok: true,
      value: {
        postType,
        event: {
          ...base.value,
          ...(startTime.value ? { startTime: startTime.value } : {}),
          ...(endTime.value ? { endTime: endTime.value } : {}),
        },
        ...withButton,
      },
    };
  }

  if (!isRecord(raw.offer)) return fail("Add the offer's title and dates.");
  const base = titleAndDates(raw.offer, "offer");
  if (!base.ok) return base;
  const couponCode = optionalText(raw.offer.couponCode, "coupon code", GOOGLE_COUPON_CODE_MAX);
  if (!couponCode.ok) return couponCode;
  const redeemUrl = httpsLink(raw.offer.redeemUrl, "redeem link", false);
  if (!redeemUrl.ok) return redeemUrl;
  const terms = optionalText(raw.offer.terms, "terms and conditions", GOOGLE_TERMS_MAX);
  if (!terms.ok) return terms;
  return {
    ok: true,
    value: {
      postType,
      offer: {
        ...base.value,
        ...(couponCode.value ? { couponCode: couponCode.value } : {}),
        ...(redeemUrl.value ? { redeemUrl: redeemUrl.value } : {}),
        ...(terms.value ? { terms: terms.value } : {}),
      },
    },
  };
}

export interface WorkspaceGoogleButton {
  googleButtonType: string | null;
  googleButtonUrl: string | null;
}

/** The workspace's default button, or undefined for none (or a stored value that no longer validates). */
export function googleButtonFromWorkspace(workspace: WorkspaceGoogleButton | null | undefined): GoogleButton | undefined {
  if (!workspace?.googleButtonType) return undefined;
  const parsed = parseGoogleButton({ type: workspace.googleButtonType, url: workspace.googleButtonUrl ?? undefined });
  return parsed.ok && parsed.value ? parsed.value : undefined;
}

/**
 * What a Google post publishes with. A post with its own options keeps them,
 * "No button" included. A post with none at all (created before this feature,
 * or through the API without them) becomes an update with the workspace's
 * default button, or stays as today when the workspace has none.
 */
export function resolveGooglePostMetadata(
  post: GoogleBusinessPostMetadata | undefined,
  workspace: WorkspaceGoogleButton | null | undefined,
): GoogleBusinessPostMetadata | undefined {
  if (post) return post;
  const button = googleButtonFromWorkspace(workspace);
  return button ? { postType: "update", button } : undefined;
}

/** The Queue card's text: "Offer", "Book button", "Event, Sign up button"; null for a plain update. */
export function googleQueueLabel(postType: string | null, buttonType: string | null): string | null {
  const parts: string[] = [];
  if (postType === "event" || postType === "offer") parts.push(GOOGLE_POST_TYPE_LABELS[postType]);
  if (buttonType && buttonType in GOOGLE_BUTTON_LABELS) {
    parts.push(`${GOOGLE_BUTTON_LABELS[buttonType as GoogleButtonType]} button`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

/** The link a new default button starts with: the company website, as https. */
export function defaultGoogleButtonUrl(companyWebsite: string | null | undefined): string {
  const site = companyWebsite?.trim() ?? "";
  if (!site) return "";
  return /^https?:\/\//i.test(site) ? site : `https://${site}`;
}
