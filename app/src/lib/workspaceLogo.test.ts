import { describe, expect, it } from "vitest";

import {
  isLogoAddress,
  logoAddressRefusal,
  logoEndpoint,
  LOGO_ADDRESS_RESERVED_MESSAGE,
  LOGO_HELP_LINE,
} from "./workspaceLogo";

const HOST = "https://store1.public.blob.vercel-storage.com";

describe("isLogoAddress", () => {
  it("is true for any file under logos/, however it is spelled", () => {
    for (const url of [
      `${HOST}/logos/0123456789abcdef0123456789abcdef.png`,
      `${HOST}/logos/ws-1/aaaaaaaaaaaaaaaa.png`,
      `  ${HOST}/logos/x.png  `,
      `${HOST}/LOGOS/x.png`,
      `${HOST}/%6Cogos/x.png`,
      `${HOST}/a/../logos/x.png`,
      `${HOST}//logos/x.png`,
      `${HOST}/logos%2Fx.png`,
      `${HOST}/logos/x.png?download=1`,
    ]) {
      expect(isLogoAddress(url), url).toBe(true);
    }
  });

  it("is false for ordinary media and for names that only start alike", () => {
    for (const url of [
      `${HOST}/1700000000000-ab12cd34-cat.png`,
      `${HOST}/ul/link-1/0123456789abcdef-IMG_1.jpg`,
      `${HOST}/logos.png`,
      `${HOST}/user-1/logos/x.png`,
      `${HOST}/logosx/y.png`,
      "not a url",
    ]) {
      expect(isLogoAddress(url), url).toBe(false);
    }
  });
});

describe("logoAddressRefusal", () => {
  it("gives the plain sentence for a logo address and null otherwise", () => {
    expect(logoAddressRefusal(`${HOST}/logos/x.png`)).toBe(LOGO_ADDRESS_RESERVED_MESSAGE);
    expect(logoAddressRefusal(`${HOST}/cat.png`)).toBeNull();
  });
});

describe("logoEndpoint", () => {
  it("names the workspace the page was rendered for", () => {
    expect(logoEndpoint("ws-1")).toBe("/api/workspaces/logo?workspaceId=ws-1");
    expect(logoEndpoint("a b&c")).toBe("/api/workspaces/logo?workspaceId=a%20b%26c");
  });
});

describe("LOGO_HELP_LINE", () => {
  it("says what the server accepts", () => {
    expect(LOGO_HELP_LINE).toBe("An image up to 1 MB (not SVG). It appears on your monthly report.");
  });
});
