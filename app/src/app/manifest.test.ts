import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import manifest from "./manifest";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));

describe("web app manifest", () => {
  const m = manifest();

  it("names the app and opens it full screen at the home page", () => {
    expect(m.name).toBe("Vibe Socials");
    expect(m.short_name).toBe("Vibe Socials");
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("lists a 192 and a 512 icon plus a 512 maskable one, and the files exist", () => {
    const icons = m.icons ?? [];
    const find = (sizes: string, purpose: string | undefined) =>
      icons.find((icon) => icon.sizes === sizes && icon.purpose === purpose);

    expect(find("192x192", "any")).toBeDefined();
    expect(find("512x512", "any")).toBeDefined();
    expect(find("512x512", "maskable")).toBeDefined();
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      expect(existsSync(`${publicDir}${icon.src}`), icon.src).toBe(true);
    }
  });

  it("accepts a shared image or video as a multipart POST to /share-target", () => {
    const target = (m as { share_target?: Record<string, unknown> }).share_target;
    expect(target).toEqual({
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: { files: [{ name: "media", accept: ["image/*", "video/*"] }] },
    });
  });
});
