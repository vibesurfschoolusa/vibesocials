import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConnectCookie, openConnectCookie, readConnectCookie, sealConnectCookie, setConnectCookie } from "./cookie";

const TOKEN = "T".repeat(43);

beforeEach(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
});
afterEach(() => vi.unstubAllEnvs());

describe("the vs_connect cookie", () => {
  it("seals the link id, the nonce and the token, and opens again", () => {
    const sealed = sealConnectCookie({ linkId: "link-1", nonce: "n-1", token: TOKEN });
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain("link-1");
    expect(openConnectCookie(sealed)).toEqual({ linkId: "link-1", nonce: "n-1", token: TOKEN });
  });

  it("anything else does not open", () => {
    expect(openConnectCookie(undefined)).toBeNull();
    expect(openConnectCookie("")).toBeNull();
    expect(openConnectCookie("enc:v1:garbage")).toBeNull();
    expect(openConnectCookie("plain")).toBeNull();
  });

  it("is read from the request's Cookie header", () => {
    const sealed = sealConnectCookie({ linkId: "link-1", nonce: "n-1", token: TOKEN });
    const res = NextResponse.redirect("https://example.com/");
    setConnectCookie(res, sealed);
    const header = res.headers.get("set-cookie") ?? "";
    const pair = header.split(";")[0];
    const request = new Request("https://app.example.com/x", { headers: { cookie: `other=1; ${pair}` } });
    expect(readConnectCookie(request)).toEqual({ linkId: "link-1", nonce: "n-1", token: TOKEN });
    expect(readConnectCookie(new Request("https://app.example.com/x"))).toBeNull();
  });

  it("is httpOnly, Secure, SameSite=Lax, path / and lasts 15 minutes", () => {
    const res = NextResponse.redirect("https://example.com/");
    setConnectCookie(res, "v");
    const header = (res.headers.get("set-cookie") ?? "").toLowerCase();
    expect(header).toMatch(/^vs_connect=v;/);
    expect(header).toContain("path=/");
    expect(header).toContain("max-age=900");
    expect(header).toContain("httponly");
    expect(header).toContain("secure");
    expect(header).toContain("samesite=lax");
  });

  it("is cleared with the same attributes", () => {
    const res = NextResponse.redirect("https://example.com/");
    clearConnectCookie(res);
    const header = (res.headers.get("set-cookie") ?? "").toLowerCase();
    expect(header).toMatch(/^vs_connect=;/);
    expect(header).toContain("max-age=0");
    expect(header).toContain("path=/");
  });
});
