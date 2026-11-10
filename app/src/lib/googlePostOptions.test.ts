import { describe, expect, it } from "vitest";

import {
  GOOGLE_BUTTON_TYPES,
  defaultGoogleButtonUrl,
  googleButtonFromWorkspace,
  changeGooglePostType,
  googleQueueLabel,
  parseGoogleButton,
  parseGooglePostMetadata,
  resolveGooglePostMetadata,
} from "./googlePostOptions";

const event = { title: "Full moon paddle", startDate: "2026-11-20", endDate: "2026-11-20" };
const offer = { title: "20% off lessons", startDate: "2026-11-20", endDate: "2026-11-30" };

const ok = (raw: unknown) => {
  const result = parseGooglePostMetadata(raw);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.value;
};
const error = (raw: unknown) => {
  const result = parseGooglePostMetadata(raw);
  if (result.ok) throw new Error("expected an error");
  return result.error;
};

describe("parseGooglePostMetadata", () => {
  it("accepts a plain update with no button", () => {
    expect(ok({ postType: "update" })).toEqual({ postType: "update" });
  });

  it.each(GOOGLE_BUTTON_TYPES.filter((t) => t !== "CALL"))("accepts a %s button with an https link", (type) => {
    expect(ok({ postType: "update", button: { type, url: "https://example.com/book" } })).toEqual({
      postType: "update",
      button: { type, url: "https://example.com/book" },
    });
  });

  it.each(GOOGLE_BUTTON_TYPES.filter((t) => t !== "CALL"))("refuses a %s button without a link", (type) => {
    expect(error({ postType: "update", button: { type } })).toMatch(/button link/i);
  });

  it("refuses a link that is not https", () => {
    expect(error({ postType: "update", button: { type: "BOOK", url: "http://example.com" } })).toMatch(
      /button link must start with https:\/\//i,
    );
    expect(error({ postType: "update", button: { type: "BOOK", url: "not a url" } })).toMatch(/button link/i);
  });

  it("accepts CALL without a link and drops a link sent with it (Google wants none)", () => {
    expect(ok({ postType: "update", button: { type: "CALL" } })).toEqual({
      postType: "update",
      button: { type: "CALL" },
    });
    expect(ok({ postType: "update", button: { type: "CALL", url: "https://example.com" } })).toEqual({
      postType: "update",
      button: { type: "CALL" },
    });
  });

  it("refuses an unknown button type and an unknown post type", () => {
    expect(error({ postType: "update", button: { type: "GET_OFFER" } })).toMatch(/button type/i);
    expect(error({ postType: "alert" })).toMatch(/post type/i);
    expect(error({})).toMatch(/post type/i);
    expect(error("update")).toMatch(/googleMetadata/);
    expect(error([])).toMatch(/googleMetadata/);
  });

  it("caps the link at 2,048 characters", () => {
    const url = `https://example.com/${"a".repeat(2048)}`;
    expect(error({ postType: "update", button: { type: "BOOK", url } })).toMatch(/button link/i);
  });

  it("refuses an offer with a button", () => {
    expect(
      error({ postType: "offer", offer, button: { type: "BOOK", url: "https://example.com" } }),
    ).toMatch(/offer can't have a button/i);
  });

  it("accepts an event with and without times, with a button", () => {
    expect(ok({ postType: "event", event })).toEqual({ postType: "event", event });
    const timed = { ...event, startTime: "18:00", endTime: "20:30" };
    expect(
      ok({ postType: "event", event: timed, button: { type: "SIGN_UP", url: "https://example.com/s" } }),
    ).toEqual({
      postType: "event",
      event: timed,
      button: { type: "SIGN_UP", url: "https://example.com/s" },
    });
  });

  it("needs an event's details, a title and real dates", () => {
    expect(error({ postType: "event" })).toMatch(/event/i);
    expect(error({ postType: "event", event: { ...event, title: "  " } })).toMatch(/event title/i);
    expect(error({ postType: "event", event: { ...event, startDate: "" } })).toMatch(/event start date/i);
    expect(error({ postType: "event", event: { ...event, endDate: "2026-02-30" } })).toMatch(/event end date/i);
    expect(error({ postType: "event", event: { ...event, startDate: "20/11/2026" } })).toMatch(
      /event start date/i,
    );
  });

  it("refuses an end before the start", () => {
    expect(error({ postType: "event", event: { ...event, endDate: "2026-11-19" } })).toMatch(
      /event end.*before.*start/i,
    );
    expect(error({ postType: "offer", offer: { ...offer, endDate: "2026-11-01" } })).toMatch(
      /offer end.*before.*start/i,
    );
    expect(
      error({ postType: "event", event: { ...event, startTime: "18:00", endTime: "17:00" } }),
    ).toMatch(/event end time must be after its start time/i);
  });

  it("on one day, refuses an end time equal to the start time", () => {
    expect(
      error({ postType: "event", event: { ...event, startTime: "10:00", endTime: "10:00" } }),
    ).toMatch(/event end time must be after its start time/i);
    // A missing time is the whole day's edge: a start at 23:59 alone ends at 23:59.
    expect(error({ postType: "event", event: { ...event, startTime: "23:59" } })).toMatch(
      /event end time must be after its start time/i,
    );
    expect(error({ postType: "event", event: { ...event, endTime: "00:00" } })).toMatch(
      /event end time must be after its start time/i,
    );
  });

  it("keeps valid a one-day event with no times (it lasts all day) and one that ends later", () => {
    expect(ok({ postType: "event", event })).toEqual({ postType: "event", event });
    expect(ok({ postType: "event", event: { ...event, startTime: "10:00", endTime: "10:01" } }).event).toMatchObject({
      startTime: "10:00",
      endTime: "10:01",
    });
    // Same times on different days are fine.
    expect(
      ok({ postType: "event", event: { ...event, endDate: "2026-11-21", startTime: "10:00", endTime: "10:00" } }),
    ).toMatchObject({ postType: "event" });
    // An offer has no times and runs whole days, so a one-day offer is valid.
    expect(ok({ postType: "offer", offer: { ...offer, endDate: offer.startDate } })).toMatchObject({
      postType: "offer",
    });
  });

  it("refuses a time that is not HH:MM", () => {
    expect(error({ postType: "event", event: { ...event, startTime: "6pm" } })).toMatch(/event start time/i);
    expect(error({ postType: "event", event: { ...event, endTime: "24:00" } })).toMatch(/event end time/i);
  });

  it("caps the title at 58 characters", () => {
    expect(ok({ postType: "event", event: { ...event, title: "a".repeat(58) } }).event?.title).toHaveLength(58);
    expect(error({ postType: "event", event: { ...event, title: "a".repeat(59) } })).toMatch(
      /event title.*58/i,
    );
    expect(error({ postType: "offer", offer: { ...offer, title: "a".repeat(59) } })).toMatch(/offer title.*58/i);
  });

  it("accepts an offer with its optional fields and caps them", () => {
    const full = {
      ...offer,
      couponCode: "SURF20",
      redeemUrl: "https://example.com/redeem",
      terms: "One per customer.",
    };
    expect(ok({ postType: "offer", offer: full })).toEqual({ postType: "offer", offer: full });
    expect(ok({ postType: "offer", offer })).toEqual({ postType: "offer", offer });
    expect(error({ postType: "offer" })).toMatch(/offer/i);
    expect(error({ postType: "offer", offer: { ...offer, couponCode: "a".repeat(59) } })).toMatch(
      /coupon code.*58/i,
    );
    expect(error({ postType: "offer", offer: { ...offer, terms: "a".repeat(5001) } })).toMatch(
      /terms.*5,000/i,
    );
    expect(error({ postType: "offer", offer: { ...offer, redeemUrl: "http://example.com" } })).toMatch(
      /redeem link/i,
    );
  });

  it("drops empty optional fields", () => {
    expect(ok({ postType: "offer", offer: { ...offer, couponCode: " ", terms: "" } })).toEqual({
      postType: "offer",
      offer,
    });
    expect(ok({ postType: "event", event: { ...event, startTime: "", endTime: "" } })).toEqual({
      postType: "event",
      event,
    });
  });

  it("drops unknown keys and the details of the other types", () => {
    expect(
      ok({
        postType: "update",
        extra: 1,
        event,
        offer,
        button: { type: "BOOK", url: "https://example.com", label: "x" },
      }),
    ).toEqual({ postType: "update", button: { type: "BOOK", url: "https://example.com" } });
    expect(ok({ postType: "event", event: { ...event, color: "red" }, offer })).toEqual({
      postType: "event",
      event,
    });
    expect(ok({ postType: "offer", offer: { ...offer, extra: true }, event })).toEqual({
      postType: "offer",
      offer,
    });
  });

  it("treats a null button as no button", () => {
    expect(ok({ postType: "update", button: null })).toEqual({ postType: "update" });
  });
});

describe("parseGoogleButton", () => {
  it("returns null for no button, the clean button otherwise", () => {
    expect(parseGoogleButton(null)).toEqual({ ok: true, value: null });
    expect(parseGoogleButton({ type: "BOOK", url: " https://example.com/b " })).toEqual({
      ok: true,
      value: { type: "BOOK", url: "https://example.com/b" },
    });
    expect(parseGoogleButton({ type: "BOOK" }).ok).toBe(false);
  });
});

describe("googleButtonFromWorkspace", () => {
  it("builds the default button from the two columns", () => {
    expect(googleButtonFromWorkspace({ googleButtonType: "BOOK", googleButtonUrl: "https://e.com/b" })).toEqual({
      type: "BOOK",
      url: "https://e.com/b",
    });
    expect(googleButtonFromWorkspace({ googleButtonType: "CALL", googleButtonUrl: null })).toEqual({
      type: "CALL",
    });
  });

  it("returns undefined for none or a value that no longer validates", () => {
    expect(googleButtonFromWorkspace({ googleButtonType: null, googleButtonUrl: "https://e.com" })).toBeUndefined();
    expect(googleButtonFromWorkspace({ googleButtonType: "BOOK", googleButtonUrl: null })).toBeUndefined();
    expect(googleButtonFromWorkspace({ googleButtonType: "NOPE", googleButtonUrl: "https://e.com" })).toBeUndefined();
    expect(googleButtonFromWorkspace(null)).toBeUndefined();
  });
});

describe("resolveGooglePostMetadata", () => {
  const workspace = { googleButtonType: "BOOK", googleButtonUrl: "https://e.com/book" };

  it("gives a post with no metadata the workspace's default button", () => {
    expect(resolveGooglePostMetadata(undefined, workspace)).toEqual({
      postType: "update",
      button: { type: "BOOK", url: "https://e.com/book" },
    });
  });

  it("gives nothing when the workspace has no default either", () => {
    expect(resolveGooglePostMetadata(undefined, { googleButtonType: null, googleButtonUrl: null })).toBeUndefined();
    expect(resolveGooglePostMetadata(undefined, null)).toBeUndefined();
  });

  it("keeps the post's own choice, including no button", () => {
    expect(resolveGooglePostMetadata({ postType: "update" }, workspace)).toEqual({ postType: "update" });
    const own = { postType: "update" as const, button: { type: "CALL" as const } };
    expect(resolveGooglePostMetadata(own, workspace)).toEqual(own);
  });
});

describe("googleQueueLabel", () => {
  it("names the type and the button", () => {
    expect(googleQueueLabel("offer", null)).toBe("Offer");
    expect(googleQueueLabel("update", "BOOK")).toBe("Book button");
    expect(googleQueueLabel("event", "SIGN_UP")).toBe("Event, Sign up button");
    expect(googleQueueLabel("event", null)).toBe("Event");
    expect(googleQueueLabel("update", null)).toBeNull();
    expect(googleQueueLabel(null, null)).toBeNull();
  });
});

describe("defaultGoogleButtonUrl", () => {
  it("starts from the company website as an https link", () => {
    expect(defaultGoogleButtonUrl("www.example.com")).toBe("https://www.example.com");
    expect(defaultGoogleButtonUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(defaultGoogleButtonUrl(" ")).toBe("");
    expect(defaultGoogleButtonUrl(null)).toBe("");
  });
});

// Review round: trying Offer and coming back must not silently lose the button.
describe("changeGooglePostType", () => {
  const book = { type: "BOOK" as const, url: "https://e.com/book" };
  const EMPTY = { title: "", startDate: "", endDate: "" };

  it("choosing Offer drops the button and remembers it", () => {
    expect(changeGooglePostType({ postType: "update", button: book }, "offer", undefined)).toEqual({
      metadata: { postType: "offer", offer: EMPTY },
      savedButton: book,
    });
  });

  it.each(["update", "event"] as const)("switching back from Offer to %s restores the remembered button", (type) => {
    const toOffer = changeGooglePostType({ postType: "update", button: book }, "offer", undefined);
    const back = changeGooglePostType(toOffer.metadata, type, toOffer.savedButton);
    expect(back.metadata.button).toEqual(book);
    expect(back.metadata.postType).toBe(type);
  });

  it("restores No button when that was the choice before Offer", () => {
    const toOffer = changeGooglePostType({ postType: "update" }, "offer", book);
    expect(toOffer.savedButton).toBeUndefined();
    expect(changeGooglePostType(toOffer.metadata, "update", toOffer.savedButton).metadata).toEqual({
      postType: "update",
    });
  });

  it("keeps the current button between Update and Event", () => {
    const call = { type: "CALL" as const };
    expect(changeGooglePostType({ postType: "update", button: call }, "event", book).metadata).toEqual({
      postType: "event",
      event: EMPTY,
      button: call,
    });
  });

  it("keeps the event's and the offer's own fields when re-choosing the same type", () => {
    const evt = { title: "Paddle", startDate: "2026-11-20", endDate: "2026-11-20" };
    expect(changeGooglePostType({ postType: "event", event: evt }, "event", undefined).metadata.event).toEqual(evt);
    const off = { title: "Deal", startDate: "2026-11-20", endDate: "2026-11-21" };
    expect(changeGooglePostType({ postType: "offer", offer: off }, "offer", book)).toEqual({
      metadata: { postType: "offer", offer: off },
      savedButton: book,
    });
  });
});
