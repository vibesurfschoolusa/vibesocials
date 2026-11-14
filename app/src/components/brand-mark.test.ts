import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrandMark } from "./brand-mark";

/**
 * 2026-11-14: the app showed a generic indigo "VS" box while the browser tab
 * showed the brand's gradient hexagon (public/VS_logo.png). Every logo is now
 * that one icon.
 */

describe("BrandMark", () => {
  it("is the app icon, decorative, at the size it is given", () => {
    const html = renderToStaticMarkup(BrandMark({ className: "h-14 w-14" }) as ReactElement);
    // React also writes a preload hint for the image ahead of it.
    expect(html).toMatch(/<img [^>]*src="\/icon\.svg"/);
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("h-14 w-14");
  });

  it("points at a file that exists: app/icon.svg, which Next serves at /icon.svg", () => {
    const icon = fileURLToPath(new URL("../app/icon.svg", import.meta.url));
    expect(existsSync(icon)).toBe(true);
    expect(readFileSync(icon, "utf8")).toContain("<svg");
  });
});

describe("no generic VS box is left", () => {
  const files = [
    "shell/brand.tsx",
    "public-shell.tsx",
    "../app/login/page.tsx",
    "../app/register/register-form.tsx",
    "../app/forgot-password/page.tsx",
    "../app/reset-password/page.tsx",
    "../app/verify-email/page.tsx",
  ];
  for (const file of files) {
    it(`${file} uses BrandMark`, () => {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
      expect(source).toContain("BrandMark");
      expect(source).not.toMatch(/>\s*VS\s*</);
      expect(source).not.toContain("from-indigo-500");
    });
  }
});
