import type { NextResponse } from "next/server";

import { CONNECT_LINK_COOKIE, CONNECT_LINK_COOKIE_MAX_AGE_SECONDS } from "@/lib/connectLink";
import { openSecret, sealSecret } from "@/lib/tokenCrypto";

/**
 * The `vs_connect` cookie: proof that the browser finishing a connect-link
 * flow is the one that pressed Connect on the link's page. Sealed, so the
 * visitor's browser holds the raw token (to be sent back to their page) without
 * it ever reaching the OAuth state, a log line or an error. One flow per
 * browser at a time: a new press replaces it.
 */

export interface ConnectCookie {
  linkId: string;
  nonce: string;
  token: string;
}

export function sealConnectCookie({ linkId, nonce, token }: ConnectCookie): string {
  return sealSecret(JSON.stringify({ l: linkId, n: nonce, t: token }));
}

export function openConnectCookie(value: string | null | undefined): ConnectCookie | null {
  if (!value || !value.startsWith("enc:")) return null;
  try {
    const data = JSON.parse(openSecret(value)) as { l?: unknown; n?: unknown; t?: unknown };
    if (typeof data?.l !== "string" || typeof data.n !== "string" || typeof data.t !== "string") return null;
    if (!data.l || !data.n || !data.t) return null;
    return { linkId: data.l, nonce: data.n, token: data.t };
  } catch {
    return null;
  }
}

/** The raw cookie value, from the Cookie header (the X callback gets a plain Request). */
export function rawConnectCookie(request: Pick<Request, "headers">): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== CONNECT_LINK_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function readConnectCookie(request: Pick<Request, "headers">): ConnectCookie | null {
  return openConnectCookie(rawConnectCookie(request));
}

const ATTRIBUTES = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

export function setConnectCookie(response: NextResponse, sealed: string): void {
  response.cookies.set(CONNECT_LINK_COOKIE, sealed, { ...ATTRIBUTES, maxAge: CONNECT_LINK_COOKIE_MAX_AGE_SECONDS });
}

export function clearConnectCookie(response: NextResponse): void {
  response.cookies.set(CONNECT_LINK_COOKIE, "", { ...ATTRIBUTES, maxAge: 0 });
}
