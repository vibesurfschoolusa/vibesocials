import type { Platform } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  classifyRateLimit,
  currentPacificMidnight,
  isRateLimitedError,
  metaRetryAt,
  nextPacificMidnight,
  pacificDayKey,
  PACIFIC_RESET_GRACE_MS,
  RATE_LIMITED_CODE,
  rateLimitedError,
  retryAtFromHeaders,
} from "./rateLimited";

// 2026-11-01 scale audit (jobs H6 / platform limits): the classifier turns a
// platform's 429 / quota response into a typed RateLimitedError so the job can
// sleep until the limit lifts instead of failing. Fixed clock so every
// `retryAt` is exact.
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 2026-11-01T12:00:00Z
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// x-rate-limit-reset 1793500000 s is 2026-11-01T02:26:40Z: an hour earlier.
const X_RESET_MS = 1793500000000;
const BEFORE_X_RESET = X_RESET_MS - 60 * MIN;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers,
  });
}

describe("rateLimitedError / isRateLimitedError", () => {
  it("builds a coded error with the platform label in its message", () => {
    const error = rateLimitedError("facebook_page", "rate_limited", 123);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("RATE_LIMITED");
    expect(RATE_LIMITED_CODE).toBe("RATE_LIMITED");
    expect(error.platform).toBe("facebook_page");
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAt).toBe(123);
    expect(error.message).toBe("Facebook Page is limiting requests right now.");
  });

  it("keeps a null retryAt", () => {
    expect(rateLimitedError("x", "daily_limit", null).retryAt).toBeNull();
  });

  it("recognizes only its own errors", () => {
    expect(isRateLimitedError(rateLimitedError("x", "rate_limited", null))).toBe(true);
    expect(isRateLimitedError(Object.assign(new Error("x"), { code: "OTHER" }))).toBe(false);
    expect(isRateLimitedError(new Error("plain"))).toBe(false);
    expect(isRateLimitedError(null)).toBe(false);
    expect(isRateLimitedError("RATE_LIMITED")).toBe(false);
    expect(isRateLimitedError({ code: "RATE_LIMITED" })).toBe(false);
  });
});

describe("retryAtFromHeaders", () => {
  it("reads Retry-After as delta-seconds", () => {
    expect(retryAtFromHeaders(new Headers({ "Retry-After": "120" }), NOW)).toBe(NOW + 120_000);
  });

  it("reads Retry-After as an HTTP-date", () => {
    const date = new Date(NOW + 90_000).toUTCString();
    expect(retryAtFromHeaders(new Headers({ "Retry-After": date }), NOW)).toBe(NOW + 90_000);
  });

  it("reads x-rate-limit-reset as epoch seconds", () => {
    expect(
      retryAtFromHeaders(new Headers({ "x-rate-limit-reset": "1793500000" }), BEFORE_X_RESET),
    ).toBe(X_RESET_MS);
  });

  it("prefers x-rate-limit-reset over Retry-After", () => {
    const headers = new Headers({ "x-rate-limit-reset": "1793500000", "Retry-After": "5" });
    expect(retryAtFromHeaders(headers, BEFORE_X_RESET)).toBe(X_RESET_MS);
  });

  it("returns null for a reset that is not in the future", () => {
    expect(retryAtFromHeaders(new Headers({ "x-rate-limit-reset": "1000" }), NOW)).toBeNull();
    // A reset equal to now is not in the future either.
    expect(
      retryAtFromHeaders(new Headers({ "x-rate-limit-reset": "1793500000" }), X_RESET_MS),
    ).toBeNull();
    expect(retryAtFromHeaders(new Headers({ "Retry-After": "0" }), NOW)).toBeNull();
    const past = new Date(NOW - 10_000).toUTCString();
    expect(retryAtFromHeaders(new Headers({ "Retry-After": past }), NOW)).toBeNull();
  });

  it("falls through to Retry-After when the reset header is stale", () => {
    const headers = new Headers({ "x-rate-limit-reset": "1000", "Retry-After": "30" });
    expect(retryAtFromHeaders(headers, NOW)).toBe(NOW + 30_000);
  });

  it("returns null for garbage or missing headers", () => {
    expect(retryAtFromHeaders(new Headers({ "Retry-After": "soon" }), NOW)).toBeNull();
    expect(retryAtFromHeaders(new Headers({ "x-rate-limit-reset": "abc" }), NOW)).toBeNull();
    expect(retryAtFromHeaders(new Headers({ "Retry-After": "-5" }), NOW)).toBeNull();
    expect(retryAtFromHeaders(new Headers(), NOW)).toBeNull();
  });
});

describe("metaRetryAt", () => {
  const header = (value: string) => new Headers({ "X-Business-Use-Case-Usage": value });

  it("converts estimated_time_to_regain_access (minutes) to a timestamp", () => {
    const value = JSON.stringify({ "123": [{ type: "pages", estimated_time_to_regain_access: 7 }] });
    expect(metaRetryAt(header(value), NOW)).toBe(NOW + 420_000);
  });

  it("takes the maximum across every entry of every id", () => {
    const value = JSON.stringify({
      "123": [
        { type: "pages", estimated_time_to_regain_access: 3 },
        { type: "instagram", estimated_time_to_regain_access: 11 },
      ],
      "456": [{ type: "pages", estimated_time_to_regain_access: 5 }],
    });
    expect(metaRetryAt(header(value), NOW)).toBe(NOW + 11 * MIN);
  });

  it("returns null for 0, a negative or a missing estimate", () => {
    expect(
      metaRetryAt(
        header(JSON.stringify({ "123": [{ type: "pages", estimated_time_to_regain_access: 0 }] })),
        NOW,
      ),
    ).toBeNull();
    expect(
      metaRetryAt(
        header(JSON.stringify({ "123": [{ type: "pages", estimated_time_to_regain_access: -2 }] })),
        NOW,
      ),
    ).toBeNull();
    expect(metaRetryAt(header(JSON.stringify({ "123": [{ type: "pages" }] })), NOW)).toBeNull();
  });

  it("returns null for a missing, non-JSON or malformed header", () => {
    expect(metaRetryAt(new Headers(), NOW)).toBeNull();
    expect(metaRetryAt(header("not json"), NOW)).toBeNull();
    expect(metaRetryAt(header("[1,2]"), NOW)).toBeNull();
    expect(metaRetryAt(header('{"123":"oops"}'), NOW)).toBeNull();
    expect(metaRetryAt(header("null"), NOW)).toBeNull();
  });
});

// Review focus: the YouTube quota resets at midnight Pacific. The DST change
// days must land on 00:00 Pacific, not an hour off.
describe("nextPacificMidnight", () => {
  it.each([
    ["the day before the fall-back day (PDT)", "2026-10-31T12:00:00Z", "2026-11-01T07:00:00Z"],
    ["00:30 PDT on the fall-back day (before 2am)", "2026-11-01T07:30:00Z", "2026-11-02T08:00:00Z"],
    ["after the fall-back change (PST)", "2026-11-01T12:00:00Z", "2026-11-02T08:00:00Z"],
    ["the day before the spring-forward day (PST)", "2027-03-13T12:00:00Z", "2027-03-14T08:00:00Z"],
    ["after the spring-forward change (PDT)", "2027-03-14T12:00:00Z", "2027-03-15T07:00:00Z"],
  ])("%s: %s -> %s", (_label, nowIso, expectedIso) => {
    expect(nextPacificMidnight(new Date(nowIso)).toISOString()).toBe(
      new Date(expectedIso).toISOString(),
    );
  });

  it("is strictly after now: exactly at Pacific midnight it returns the following midnight", () => {
    expect(nextPacificMidnight(new Date("2026-11-01T07:00:00Z")).toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    );
    expect(nextPacificMidnight(new Date("2026-11-01T06:59:59.999Z")).toISOString()).toBe(
      "2026-11-01T07:00:00.000Z",
    );
  });

  it("handles a plain summer day and a year boundary", () => {
    expect(nextPacificMidnight(new Date("2026-07-15T20:00:00Z")).toISOString()).toBe(
      "2026-07-16T07:00:00.000Z",
    );
    expect(nextPacificMidnight(new Date("2026-12-31T20:00:00Z")).toISOString()).toBe(
      "2027-01-01T08:00:00.000Z",
    );
  });
});

// Independent of the hand-computed vectors above: sweep every half hour around
// both DST changes and check the defining property of "next Pacific midnight".
describe("nextPacificMidnight — sweep across the DST change days", () => {
  it.each([
    ["fall back 2026-11-01", Date.UTC(2026, 9, 30, 0, 0, 0)],
    ["spring forward 2027-03-14", Date.UTC(2027, 2, 12, 0, 0, 0)],
  ])("%s: the result is the first instant of the next Pacific day", (_label, start) => {
    for (let t = start; t < start + 5 * DAY; t += 30 * MIN) {
      const next = nextPacificMidnight(new Date(t));
      // Strictly after now, within a day (25 h at most on the fall-back day).
      expect(next.getTime()).toBeGreaterThan(t);
      expect(next.getTime() - t).toBeLessThanOrEqual(25 * 60 * MIN);
      // It is the very first instant of a new Pacific day...
      expect(pacificDayKey(next)).not.toBe(pacificDayKey(new Date(t)));
      expect(pacificDayKey(new Date(next.getTime() - 1))).toBe(pacificDayKey(new Date(t)));
      // ...and the Pacific clock reads 00:00 there.
      const clock = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(next);
      expect(clock).toBe("00:00:00");
    }
  });
});

// 2026-11-01 scale audit (platform limits, ruling R23): a YouTube quota refusal in
// the first minutes of a Pacific day is Google's reset lagging, not a spent
// budget. The run needs the day's own midnight to tell: the most recent one.
describe("currentPacificMidnight", () => {
  it.each([
    ["the day before the fall-back day (PDT)", "2026-10-31T12:00:00Z", "2026-10-31T07:00:00Z"],
    ["00:30 PDT on the fall-back day (before 2am)", "2026-11-01T07:30:00Z", "2026-11-01T07:00:00Z"],
    ["the repeated 1am hour (01:30 PST)", "2026-11-01T09:30:00Z", "2026-11-01T07:00:00Z"],
    ["after the fall-back change (04:00 PST)", "2026-11-01T12:00:00Z", "2026-11-01T07:00:00Z"],
    ["23:59:59 PST on the fall-back day", "2026-11-02T07:59:59Z", "2026-11-01T07:00:00Z"],
    ["00:02 PST the day after", "2026-11-02T08:02:00Z", "2026-11-02T08:00:00Z"],
    ["00:30 PDT on the NEXT fall-back day (2027-11-07)", "2027-11-07T07:30:00Z", "2027-11-07T07:00:00Z"],
    ["00:02 PST after the next fall-back day", "2027-11-08T08:02:00Z", "2027-11-08T08:00:00Z"],
    ["23:59:59 PST before the spring-forward day", "2027-03-14T07:59:59Z", "2027-03-13T08:00:00Z"],
    ["the spring-forward day, 00:00 PST sharp", "2027-03-14T08:00:00Z", "2027-03-14T08:00:00Z"],
    ["after the spring-forward change (05:00 PDT)", "2027-03-14T12:00:00Z", "2027-03-14T08:00:00Z"],
    ["23:59:59 PDT on the spring-forward day", "2027-03-15T06:59:59Z", "2027-03-14T08:00:00Z"],
    ["the day after spring forward, 00:00 PDT sharp", "2027-03-15T07:00:00Z", "2027-03-15T07:00:00Z"],
    ["a plain summer day", "2026-07-15T20:00:00Z", "2026-07-15T07:00:00Z"],
    ["a year boundary", "2027-01-01T03:00:00Z", "2026-12-31T08:00:00Z"],
  ])("%s: %s -> %s", (_label, nowIso, expectedIso) => {
    expect(currentPacificMidnight(new Date(nowIso)).toISOString()).toBe(
      new Date(expectedIso).toISOString(),
    );
  });

  it("is at or before now: exactly at Pacific midnight it returns that midnight", () => {
    expect(currentPacificMidnight(new Date("2026-11-01T07:00:00Z")).toISOString()).toBe(
      "2026-11-01T07:00:00.000Z",
    );
    expect(currentPacificMidnight(new Date("2026-11-01T06:59:59.999Z")).toISOString()).toBe(
      "2026-10-31T07:00:00.000Z",
    );
  });
});

// Independent of the vectors above: sweep every half hour around both DST
// changes (and the next fall-back) and check the defining property.
describe("currentPacificMidnight — sweep across the DST change days", () => {
  it.each([
    ["fall back 2026-11-01", Date.UTC(2026, 9, 30, 0, 0, 0)],
    ["spring forward 2027-03-14", Date.UTC(2027, 2, 12, 0, 0, 0)],
    ["fall back 2027-11-07", Date.UTC(2027, 10, 5, 0, 0, 0)],
  ])("%s: the result is the first instant of the Pacific day containing now", (_label, start) => {
    for (let t = start; t < start + 5 * DAY; t += 30 * MIN) {
      const now = new Date(t);
      const current = currentPacificMidnight(now);
      // At or before now, within the day (25 h at most on the fall-back day).
      expect(current.getTime()).toBeLessThanOrEqual(t);
      expect(t - current.getTime()).toBeLessThan(25 * 60 * MIN);
      // It is the very first instant of now's Pacific day...
      expect(pacificDayKey(current)).toBe(pacificDayKey(now));
      expect(pacificDayKey(new Date(current.getTime() - 1))).not.toBe(pacificDayKey(now));
      // ...the Pacific clock reads 00:00 there...
      const clock = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(current);
      expect(clock).toBe("00:00:00");
      // ...and the next midnight is the one after it.
      expect(nextPacificMidnight(now).getTime()).toBe(nextPacificMidnight(current).getTime());
      expect(nextPacificMidnight(now).getTime()).toBeGreaterThan(t);
    }
  });
});

describe("pacificDayKey", () => {
  it("rolls over at midnight Pacific (07:00Z on the fall-back day)", () => {
    expect(pacificDayKey(new Date("2026-11-01T06:59:59Z"))).toBe("2026-10-31");
    expect(pacificDayKey(new Date("2026-11-01T07:00:00Z"))).toBe("2026-11-01");
  });

  it("stays on the same Pacific day across the fall-back repeat of 1am", () => {
    expect(pacificDayKey(new Date("2026-11-01T08:30:00Z"))).toBe("2026-11-01"); // 01:30 PDT
    expect(pacificDayKey(new Date("2026-11-01T09:30:00Z"))).toBe("2026-11-01"); // 01:30 PST
    expect(pacificDayKey(new Date("2026-11-02T07:59:59Z"))).toBe("2026-11-01"); // 23:59:59 PST
    expect(pacificDayKey(new Date("2026-11-02T08:00:00Z"))).toBe("2026-11-02");
  });

  it("rolls over at 08:00Z on the spring-forward day, 07:00Z after it", () => {
    expect(pacificDayKey(new Date("2027-03-14T07:59:59Z"))).toBe("2027-03-13");
    expect(pacificDayKey(new Date("2027-03-14T08:00:00Z"))).toBe("2027-03-14");
    expect(pacificDayKey(new Date("2027-03-15T06:59:59Z"))).toBe("2027-03-14");
    expect(pacificDayKey(new Date("2027-03-15T07:00:00Z"))).toBe("2027-03-15");
  });
});

describe("PACIFIC_RESET_GRACE_MS", () => {
  it("is 5 minutes", () => {
    expect(PACIFIC_RESET_GRACE_MS).toBe(300_000);
  });
});

describe("classifyRateLimit", () => {
  const ytReset = nextPacificMidnight(new Date(NOW)).getTime() + PACIFIC_RESET_GRACE_MS;

  const youtubeBody = (status: number, reason: string, via: "errors" | "details" = "errors") =>
    json(
      status,
      {
        error: {
          code: status,
          message: "nope",
          ...(via === "errors"
            ? { errors: [{ domain: "youtube.quota", reason, message: "nope" }] }
            : { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] }),
        },
      },
      { "Retry-After": "40" },
    );

  async function classify(platform: Platform, res: Response) {
    return classifyRateLimit(platform, res, NOW);
  }

  describe("x", () => {
    it("classifies a 429 using x-rate-limit-reset (epoch seconds)", async () => {
      const error = await classifyRateLimit(
        "x",
        json(429, "", { "x-rate-limit-reset": "1793500000", "Retry-After": "5" }),
        BEFORE_X_RESET,
      );
      expect(error).toMatchObject({
        code: "RATE_LIMITED",
        platform: "x",
        kind: "rate_limited",
        retryAt: X_RESET_MS,
      });
    });

    it("falls back to Retry-After, then to null", async () => {
      expect((await classify("x", json(429, "", { "Retry-After": "60" })))?.retryAt).toBe(
        NOW + 60_000,
      );
      expect((await classify("x", json(429, "")))?.retryAt).toBeNull();
    });

    it("ignores other statuses", async () => {
      expect(await classify("x", json(500, ""))).toBeNull();
      expect(await classify("x", json(200, { ok: true }))).toBeNull();
      expect(await classify("x", json(403, ""))).toBeNull();
    });
  });

  describe("youtube", () => {
    it.each(["quotaExceeded", "dailyLimitExceeded"])(
      "classifies a 403 %s as youtube_quota until the next Pacific midnight plus grace",
      async (reason) => {
        const error = await classify("youtube", youtubeBody(403, reason));
        expect(error).toMatchObject({
          code: "RATE_LIMITED",
          platform: "youtube",
          kind: "youtube_quota",
          retryAt: ytReset,
        });
        // 2026-11-02T08:00:00Z + 5 min.
        expect(error?.retryAt).toBe(Date.UTC(2026, 10, 2, 8, 5, 0));
      },
    );

    it("classifies a 400 uploadLimitExceeded as daily_limit until the next Pacific midnight plus grace", async () => {
      const error = await classify("youtube", youtubeBody(400, "uploadLimitExceeded"));
      expect(error).toMatchObject({ kind: "daily_limit", retryAt: ytReset });
    });

    it.each(["rateLimitExceeded", "userRateLimitExceeded"])(
      "classifies a 403 %s as rate_limited with Retry-After",
      async (reason) => {
        const error = await classify("youtube", youtubeBody(403, reason));
        expect(error).toMatchObject({ kind: "rate_limited", retryAt: NOW + 40_000 });
      },
    );

    it("classifies any 429 as rate_limited with Retry-After", async () => {
      const error = await classify("youtube", json(429, "", { "Retry-After": "15" }));
      expect(error).toMatchObject({ kind: "rate_limited", retryAt: NOW + 15_000 });
    });

    it("reads the reason from error.details[] too", async () => {
      const error = await classify("youtube", youtubeBody(403, "quotaExceeded", "details"));
      expect(error).toMatchObject({ kind: "youtube_quota", retryAt: ytReset });
    });

    it("returns null for other reasons, statuses and unparseable bodies", async () => {
      expect(await classify("youtube", youtubeBody(403, "forbidden"))).toBeNull();
      expect(await classify("youtube", youtubeBody(401, "authError"))).toBeNull();
      expect(await classify("youtube", youtubeBody(400, "quotaExceeded"))).toBeNull();
      expect(await classify("youtube", youtubeBody(403, "uploadLimitExceeded"))).toBeNull();
      expect(await classify("youtube", json(403, "<html>forbidden</html>"))).toBeNull();
      expect(await classify("youtube", json(500, ""))).toBeNull();
      expect(await classify("youtube", json(200, { id: "v1" }))).toBeNull();
    });
  });

  describe("tiktok", () => {
    it("classifies an HTTP 429 with Retry-After", async () => {
      const error = await classify("tiktok", json(429, "", { "Retry-After": "30" }));
      expect(error).toMatchObject({ platform: "tiktok", kind: "rate_limited", retryAt: NOW + 30_000 });
    });

    it("classifies a 200 whose body error.code is rate_limit_exceeded", async () => {
      const error = await classify(
        "tiktok",
        json(200, { error: { code: "rate_limit_exceeded", message: "slow down", log_id: "L" } }),
      );
      expect(error).toMatchObject({ platform: "tiktok", kind: "rate_limited", retryAt: null });
    });

    it("returns null for ok bodies, other codes and non-JSON bodies", async () => {
      expect(await classify("tiktok", json(200, { error: { code: "ok" } }))).toBeNull();
      expect(await classify("tiktok", json(400, { error: { code: "invalid_param" } }))).toBeNull();
      expect(await classify("tiktok", json(200, ""))).toBeNull();
      expect(await classify("tiktok", json(500, "oops"))).toBeNull();
    });
  });

  describe("instagram and facebook_page", () => {
    const metaBody = (code: number, subcode?: number) =>
      json(
        400,
        { error: { message: "m", type: "OAuthException", code, error_subcode: subcode } },
        {},
      );

    it.each([4, 17, 32, 613, 80001, 80002])("classifies body error code %s as rate_limited", async (code) => {
      for (const platform of ["instagram", "facebook_page"] as const) {
        const error = await classify(platform, metaBody(code));
        expect(error).toMatchObject({ platform, kind: "rate_limited", retryAt: null });
      }
    });

    it("prefers the business-use-case estimate for retryAt", async () => {
      const res = json(
        400,
        { error: { code: 80002 } },
        {
          "X-Business-Use-Case-Usage": JSON.stringify({
            "1": [{ type: "instagram", estimated_time_to_regain_access: 3 }],
          }),
          "Retry-After": "10",
        },
      );
      expect((await classify("instagram", res))?.retryAt).toBe(NOW + 3 * MIN);
    });

    it("falls back to Retry-After when there is no business-use-case header", async () => {
      const res = json(400, { error: { code: 4 } }, { "Retry-After": "90" });
      expect((await classify("facebook_page", res))?.retryAt).toBe(NOW + 90_000);
    });

    it("classifies an HTTP 429 as rate_limited", async () => {
      const error = await classify("instagram", json(429, "", { "Retry-After": "20" }));
      expect(error).toMatchObject({ kind: "rate_limited", retryAt: NOW + 20_000 });
    });

    it("does not treat code 4 with subcode 2207051 (spam) as a rate limit", async () => {
      expect(await classify("instagram", metaBody(4, 2207051))).toBeNull();
      expect(await classify("facebook_page", metaBody(4, 2207051))).toBeNull();
    });

    it("still classifies code 4 with another subcode", async () => {
      expect(await classify("instagram", metaBody(4, 1349210))).toMatchObject({
        kind: "rate_limited",
      });
    });

    it("classifies Instagram code 9 / subcode 2207042 as daily_limit for 24 hours", async () => {
      const error = await classify("instagram", metaBody(9, 2207042));
      expect(error).toMatchObject({
        platform: "instagram",
        kind: "daily_limit",
        retryAt: NOW + DAY,
      });
    });

    it("does not apply the Instagram daily limit to Facebook, or to code 9 with another subcode", async () => {
      expect(await classify("facebook_page", metaBody(9, 2207042))).toBeNull();
      expect(await classify("instagram", metaBody(9, 123))).toBeNull();
    });

    it("returns null for auth errors, other codes, non-JSON bodies and 500s", async () => {
      expect(await classify("instagram", metaBody(190))).toBeNull();
      expect(await classify("instagram", metaBody(100))).toBeNull();
      expect(await classify("instagram", json(400, "<html>bad</html>"))).toBeNull();
      expect(await classify("facebook_page", json(500, ""))).toBeNull();
      expect(await classify("facebook_page", json(200, { id: "p1" }))).toBeNull();
    });
  });

  describe("linkedin and google_business_profile", () => {
    it("classifies a LinkedIn 429 with Retry-After", async () => {
      const error = await classify("linkedin", json(429, "", { "Retry-After": "45" }));
      expect(error).toMatchObject({ platform: "linkedin", kind: "rate_limited", retryAt: NOW + 45_000 });
    });

    it("classifies a GBP 429 with Retry-After, or without", async () => {
      expect(
        (await classify("google_business_profile", json(429, "", { "Retry-After": "30" })))?.retryAt,
      ).toBe(NOW + 30_000);
      expect((await classify("google_business_profile", json(429, "")))?.retryAt).toBeNull();
    });

    it("returns null for other statuses", async () => {
      expect(await classify("linkedin", json(403, ""))).toBeNull();
      expect(await classify("linkedin", json(500, ""))).toBeNull();
      expect(await classify("google_business_profile", json(403, ""))).toBeNull();
    });
  });

  it("returns null for a 500 on every platform", async () => {
    for (const platform of [
      "x",
      "youtube",
      "tiktok",
      "instagram",
      "facebook_page",
      "linkedin",
      "google_business_profile",
    ] as const) {
      expect(await classify(platform, json(500, "boom"))).toBeNull();
    }
  });

  it("defaults the clock to Date.now()", async () => {
    const before = Date.now();
    const error = await classifyRateLimit("linkedin", json(429, "", { "Retry-After": "60" }));
    expect(error?.retryAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(error?.retryAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  // The callers read the body again (assertOk logs it, clients parse it), so
  // classification must leave the original response unread.
  it("reads a clone: the original body is still readable afterwards", async () => {
    const original = JSON.stringify({ error: { code: "rate_limit_exceeded", log_id: "L1" } });
    for (const [platform, res] of [
      ["tiktok", json(200, original)],
      ["youtube", json(403, { error: { errors: [{ reason: "quotaExceeded" }] } })],
      ["instagram", json(400, { error: { code: 4 } })],
    ] as const) {
      const text = await res.clone().text();
      await classify(platform, res);
      expect(res.bodyUsed).toBe(false);
      expect(await res.text()).toBe(text);
    }
  });

  it("survives a response whose body was already consumed", async () => {
    const res = json(400, { error: { code: 4 } });
    await res.text();
    expect(await classify("instagram", res)).toBeNull();
    // A status-only rule does not need the body at all.
    const limited = json(429, "");
    await limited.text();
    expect(await classify("linkedin", limited)).toMatchObject({ kind: "rate_limited" });
  });
});
