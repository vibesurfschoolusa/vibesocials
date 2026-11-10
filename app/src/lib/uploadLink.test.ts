import { describe, expect, it } from "vitest";

import {
  UPLOAD_LINK_DAILY_LIMIT_MESSAGE,
  UPLOAD_LINK_FILES_PER_DAY,
  UPLOAD_LINK_INACTIVE_MESSAGE,
  UPLOAD_LINK_STORAGE_FULL_MESSAGE,
  UPLOAD_LINK_TEXT_MAX,
  cleanSenderText,
  isUploadLinkBlobPath,
  isUploadLinkPathname,
  isUploadLinkTokenShape,
  uploadLinkIdOfBlobUrl,
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

const STORE = "store1";
const HEX = "0123456789abcdef";
const GOOD = `${HOST}/ul/link-1/${HEX}-IMG_1.jpg`;

describe("isUploadLinkPathname (the shape the upload route writes)", () => {
  it("accepts ul/<id>/<16 hex>-<safe name>", () => {
    expect(isUploadLinkPathname(`ul/link-1/${HEX}-IMG_1.jpg`, "link-1")).toBe(true);
    expect(isUploadLinkPathname(`ul/link-1/${HEX}-a.b_c-d`, "link-1")).toBe(true);
  });

  it("accepts every path uploadLinkPathname makes", () => {
    for (const name of ["IMG 5252 (1).jpg", "../x/evil.jpg", "", "..", `${"a".repeat(300)}.jpg`, "ñandú.mov"]) {
      expect(isUploadLinkPathname(uploadLinkPathname("link-1", name, HEX), "link-1"), name).toBe(true);
    }
  });

  it("refuses anything else", () => {
    for (const pathname of [
      `ul/link-2/${HEX}-a.jpg`,
      `ul/link-1x/${HEX}-a.jpg`,
      `/ul/link-1/${HEX}-a.jpg`,
      `UL/link-1/${HEX}-a.jpg`,
      `ul/LINK-1/${HEX}-a.jpg`,
      `ul/link-1/${HEX.toUpperCase()}-a.jpg`,
      `ul/link-1/0123456789abcde-a.jpg`,
      `ul/link-1/${HEX}-`,
      `ul/link-1/${HEX}a.jpg`,
      `ul/link-1/${HEX}-a/b.jpg`,
      `ul/link-1/${HEX}-..%2Fa.jpg`,
      `ul/link-1/${HEX}-%2E%2E`,
      `ul/link-1/../link-2/${HEX}-a.jpg`,
      `ul/link-1/${HEX}-a b.jpg`,
      `ul/link-1/${HEX}-${"a".repeat(101)}`,
    ]) {
      expect(isUploadLinkPathname(pathname, "link-1"), pathname).toBe(false);
    }
  });

  it("refuses an empty or odd link id", () => {
    expect(isUploadLinkPathname(`ul//${HEX}-a.jpg`, "")).toBe(false);
    expect(isUploadLinkPathname(`ul/a.b/${HEX}-a.jpg`, "a.b")).toBe(false);
  });
});

describe("isUploadLinkBlobPath (the full address)", () => {
  it("accepts this link's file on the app's own storage host", () => {
    expect(isUploadLinkBlobPath(GOOD, "link-1", STORE)).toBe(true);
  });

  it("refuses another link's id and a longer id", () => {
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-2/${HEX}-IMG_1.jpg`, "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-1x/${HEX}-IMG_1.jpg`, "link-1", STORE)).toBe(false);
  });

  it("refuses encoded slashes and dots, and dot segments", () => {
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-1/${HEX}-..%2Fx.jpg`, "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul%2Flink-1/${HEX}-x.jpg`, "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-1/%2E%2E/link-2/${HEX}-x.jpg`, "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(`${HOST}/ul/link-2/../link-1/${HEX}-x.jpg`, "link-1", STORE)).toBe(false);
  });

  it("refuses an upper-case variant", () => {
    expect(isUploadLinkBlobPath(GOOD.replace("/ul/", "/UL/"), "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(GOOD.toUpperCase(), "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(GOOD.replace("store1", "STORE1"), "link-1", STORE)).toBe(false);
  });

  it("refuses a loopback host and any other host", () => {
    for (const url of [
      `http://localhost:9366/ul/link-1/${HEX}-IMG_1.jpg`,
      `https://localhost/ul/link-1/${HEX}-IMG_1.jpg`,
      `http://127.0.0.1/ul/link-1/${HEX}-IMG_1.jpg`,
      `https://[::1]/ul/link-1/${HEX}-IMG_1.jpg`,
      `https://store2.public.blob.vercel-storage.com/ul/link-1/${HEX}-IMG_1.jpg`,
      `https://store1.private.blob.vercel-storage.com/ul/link-1/${HEX}-IMG_1.jpg`,
      `https://evil.example/ul/link-1/${HEX}-IMG_1.jpg`,
      `https://store1.public.blob.vercel-storage.com.evil.example/ul/link-1/${HEX}-IMG_1.jpg`,
      `http://store1.public.blob.vercel-storage.com/ul/link-1/${HEX}-IMG_1.jpg`,
    ]) {
      expect(isUploadLinkBlobPath(url, "link-1", STORE), url).toBe(false);
    }
  });

  it("refuses a port, credentials, a query or a fragment", () => {
    expect(isUploadLinkBlobPath(GOOD.replace(".com/", ".com:443/"), "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(GOOD.replace("https://", "https://u:p@"), "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(`${GOOD}?x=1`, "link-1", STORE)).toBe(false);
    expect(isUploadLinkBlobPath(`${GOOD}#x`, "link-1", STORE)).toBe(false);
  });

  it("refuses everything when the app's store is not known", () => {
    expect(isUploadLinkBlobPath(GOOD, "link-1", null)).toBe(false);
  });
});

describe("uploadLinkIdOfBlobUrl (the cheap check before any limit)", () => {
  it("gives the link id of a well-formed address, else null", () => {
    expect(uploadLinkIdOfBlobUrl(GOOD, STORE)).toBe("link-1");
    expect(uploadLinkIdOfBlobUrl(`${HOST}/1700-abc-a.jpg`, STORE)).toBeNull();
    expect(uploadLinkIdOfBlobUrl(`http://localhost:9366/ul/link-1/${HEX}-a.jpg`, STORE)).toBeNull();
    expect(uploadLinkIdOfBlobUrl(GOOD, null)).toBeNull();
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
