import { describe, expect, it } from "vitest";

import {
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_FILES_PER_DAY,
  UPLOAD_LINK_INACTIVE_MESSAGE,
  UPLOAD_LINK_STORAGE_FULL_MESSAGE,
  UPLOAD_LINK_TEXT_MAX,
  cleanSenderText,
  isUploadLinkBlobPath,
  isUploadLinkTokenShape,
  requestIp,
  uploadLinkHourWindow,
  uploadLinkPathname,
  uploadLinkStoragePrefix,
  uploadLinkUrl,
} from "./uploadLink";

const HOST = "https://store1.public.blob.vercel-storage.com";

describe("the sentences and limits", () => {
  it("uses the brief's exact words", () => {
    expect(UPLOAD_LINK_INACTIVE_MESSAGE).toBe("This link is not active. Ask for a new one.");
    expect(UPLOAD_LINK_STORAGE_FULL_MESSAGE).toBe(
      "This workspace cannot take more files right now. Tell the person who gave you the link.",
    );
    expect(UPLOAD_LINK_DAILY_LIMIT_MESSAGE).toBe(
      "This link has reached today's limit. Try again tomorrow.",
    );
    expect(UPLOAD_LINK_FILES_PER_DAY).toBe(200);
    expect(UPLOAD_LINK_TEXT_MAX).toBe(200);
  });
});

describe("uploadLinkStoragePrefix", () => {
  it("is ul/<link id>/", () => {
    expect(uploadLinkStoragePrefix("link-1")).toBe("ul/link-1/");
  });
});

describe("isUploadLinkBlobPath", () => {
  it("accepts a file under this link's prefix", () => {
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-1/abc-photo.jpg`, "link-1")).toBe(true);
  });

  it("refuses a file outside the prefix, or under another link's", () => {
    expect(isUploadLinkBlobPath(`${HOST}/123-photo.jpg`, "link-1")).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-2/photo.jpg`, "link-1")).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-10/photo.jpg`, "link-1")).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/x/ul/link-1/photo.jpg`, "link-1")).toBe(false);
  });

  it("refuses the bare prefix and dot segments that leave it", () => {
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-1/`, "link-1")).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-1`, "link-1")).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-1/../link-2/a.jpg`, "link-1")).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul%2Flink-1/a.jpg`, "link-1")).toBe(false);
  });

  it("refuses a value that is not a URL, and an empty link id", () => {
    expect(isUploadLinkBlobPath("ul/link-1/a.jpg", "link-1")).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul//a.jpg`, "")).toBe(false);
  });
});

describe("uploadLinkPathname", () => {
  it("puts the file under the link's prefix with a random part and a safe name", () => {
    expect(uploadLinkPathname("link-1", "IMG 5252 (1).jpg", "r4nd0m")).toBe(
      "ul/link-1/r4nd0m-IMG_5252__1_.jpg",
    );
  });

  it("keeps only the last part of a path the browser sent", () => {
    expect(uploadLinkPathname("link-1", "../ul/link-2/evil.jpg", "r")).toBe("ul/link-1/r-evil.jpg");
    expect(uploadLinkPathname("link-1", "C:\\photos\\a.png", "r")).toBe("ul/link-1/r-a.png");
  });

  it("falls back to a plain name and caps a long one", () => {
    expect(uploadLinkPathname("link-1", "", "r")).toBe("ul/link-1/r-file");
    expect(uploadLinkPathname("link-1", "..", "r")).toBe("ul/link-1/r-file");
    const long = `${"a".repeat(300)}.jpg`;
    const result = uploadLinkPathname("link-1", long, "r");
    expect(result.startsWith("ul/link-1/r-")).toBe(true);
    expect(result.length).toBeLessThanOrEqual("ul/link-1/r-".length + 100);
    expect(result.endsWith(".jpg")).toBe(true);
  });
});

describe("cleanSenderText", () => {
  it("trims, and gives null for nothing", () => {
    expect(cleanSenderText("  Ana  ")).toBe("Ana");
    expect(cleanSenderText("   ")).toBeNull();
    expect(cleanSenderText(undefined)).toBeNull();
    expect(cleanSenderText(42)).toBeNull();
  });

  it("caps at 200 characters without splitting a character", () => {
    expect(cleanSenderText("x".repeat(250))).toBe("x".repeat(200));
    const emoji = "\u{1F30A}".repeat(250);
    const capped = cleanSenderText(emoji)!;
    expect(Array.from(capped)).toHaveLength(200);
  });

  it("puts a name on one line", () => {
    expect(cleanSenderText("Ana\r\nBcc: x", { singleLine: true })).toBe("Ana Bcc: x");
    expect(cleanSenderText("line one\nline two")).toBe("line one\nline two");
  });
});

describe("uploadLinkUrl", () => {
  it("is /u/<token> on the site", () => {
    expect(uploadLinkUrl("https://vibesocials.wtf", "tok")).toBe("https://vibesocials.wtf/u/tok");
    expect(uploadLinkUrl(undefined, "tok")).toBe("/u/tok");
  });
});

describe("isUploadLinkTokenShape", () => {
  it("accepts a 43-character base64url token only", () => {
    expect(isUploadLinkTokenShape("A".repeat(43))).toBe(true);
    expect(isUploadLinkTokenShape("A-_".repeat(14) + "A")).toBe(true);
    expect(isUploadLinkTokenShape("A".repeat(42))).toBe(false);
    expect(isUploadLinkTokenShape("A".repeat(44))).toBe(false);
    expect(isUploadLinkTokenShape(`${"A".repeat(42)}/`)).toBe(false);
  });
});

describe("uploadLinkHourWindow", () => {
  it("names the UTC hour and ends at the next one", () => {
    const window = uploadLinkHourWindow(new Date("2026-11-10T17:42:10Z"));
    expect(window.key).toBe("2026-11-10T17");
    expect(window.end.toISOString()).toBe("2026-11-10T18:00:00.000Z");
  });
});

describe("requestIp", () => {
  it("takes the first x-forwarded-for entry, as the register route does", () => {
    const headers = new Headers({ "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" });
    expect(requestIp(new Request("http://x", { headers }))).toBe("203.0.113.9");
    expect(requestIp(new Request("http://x"))).toBe("unknown");
    expect(requestIp(new Request("http://x", { headers: { "x-forwarded-for": "" } }))).toBe("unknown");
  });
});
