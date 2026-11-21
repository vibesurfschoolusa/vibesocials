import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CoverChoice } from "@/lib/videoCover";

import { VideoCoverPicker } from "./video-cover-picker";

// R65 review L1: Create locks the cover during a waiting send through this
// prop, on the picker's own fieldset, so nothing wraps it.
describe("VideoCoverPicker - disabled", () => {
  const html = (value: CoverChoice, disabled?: boolean) =>
    renderToStaticMarkup(
      createElement(VideoCoverPicker, {
        videoUrl: "https://blob.example/v.mp4",
        durationSec: 10,
        value,
        onChange: () => {},
        ...(disabled === undefined ? {} : { disabled }),
      }),
    );
  const fieldsets = (markup: string) => markup.match(/<fieldset[^>]*>/g) ?? [];
  const FRAME: CoverChoice = { kind: "frame", timeMs: 0 };

  it("with disabled: its one fieldset is disabled, so the choices and the frame slider are", () => {
    const markup = html(FRAME, true);
    expect(fieldsets(markup)).toHaveLength(1);
    expect(fieldsets(markup)[0]).toContain('disabled=""');
    expect(markup.startsWith("<fieldset")).toBe(true);
  });

  it("without disabled: as now", () => {
    for (const markup of [html(FRAME), html(FRAME, false)]) {
      expect(fieldsets(markup)).toHaveLength(1);
      expect(fieldsets(markup)[0]).not.toContain(" disabled=\"\"");
      expect(markup.match(/<input[^>]*id="video-cover-frame"[^>]*>/)?.[0]).not.toContain(" disabled=\"\"");
    }
  });
});
