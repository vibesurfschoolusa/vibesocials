import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  barTikTokDeclaration,
  composerPageView,
  FILE_LOST_PRESS_TOAST,
  submitButtonLabel,
  submitControl,
  UNTOUCHED_SUBMIT_MESSAGE,
} from "../create-post-form";
import { TikTokConsentDeclaration } from "../tiktok-post-settings";
import { ToastProvider } from "../ui/toast";
import { PUBLISH_BAR_OFFSET_VAR, PublishBar, publishBarOffset } from "./publish-bar";

const base = {
  loading: false,
  caption: "hello",
  tiktokBlock: null,
  fileBlock: null,
  untouchedMessage: null,
  platformAlert: null,
};

const render = (
  control: ReturnType<typeof submitControl>,
  dialogOpen = false,
  tiktokDeclaration: { brandedContent: boolean } | null = null,
) => renderToStaticMarkup(createElement(PublishBar, { formId: "create-post", control, dialogOpen, tiktokDeclaration }));

describe("submitControl: the one source for the form's button and the bar", () => {
  it("every page state and publish mode: the label is the page's own", () => {
    for (const pageState of ["untouched", "text", "file"] as const) {
      for (const mode of ["now", "schedule", "draft"] as const) {
        for (const loading of [false, true]) {
          const view = composerPageView({
            pageState,
            connected: ["instagram", "x"],
            deselected: new Set(),
            mimeType: pageState === "file" ? "image/jpeg" : null,
            mode,
            loading,
            triedSend: false,
          });
          const control = submitControl({ ...base, buttonLabel: view.buttonLabel, loading });
          expect(control.label).toBe(submitButtonLabel({ mode, noFile: pageState === "text", loading }));
          expect(control.loading).toBe(loading);
          const html = render(control);
          expect(html).toContain(control.label);
          if (loading) expect(html).toContain("disabled");
        }
      }
    }
  });

  it("disabled exactly when the form's button was: caption over the cap, TikTok blocked, a file not ready", () => {
    const control = (fields: Partial<Parameters<typeof submitControl>[0]>) =>
      submitControl({ ...base, buttonLabel: "Publish post", ...fields });
    expect(control({}).disabled).toBe(false);
    expect(control({ caption: "a".repeat(10_000) }).disabled).toBe(false);
    expect(control({ caption: "a".repeat(10_001) }).disabled).toBe(true);
    expect(control({ tiktokBlock: "Choose who can see this video." }).disabled).toBe(true);
    expect(control({ fileBlock: "Wait until the file is ready, then press the button again." }).disabled).toBe(true);
    // A sentence that only explains a press does not disable the button.
    expect(control({ untouchedMessage: UNTOUCHED_SUBMIT_MESSAGE }).disabled).toBe(false);
    expect(control({ platformAlert: "Select at least one platform." }).disabled).toBe(false);
  });

  it("the reason line for each blocking cause", () => {
    const reason = (fields: Partial<Parameters<typeof submitControl>[0]>) =>
      submitControl({ ...base, buttonLabel: "Publish post", ...fields }).reason;
    expect(reason({})).toBeNull();
    expect(reason({ untouchedMessage: UNTOUCHED_SUBMIT_MESSAGE })).toBe(UNTOUCHED_SUBMIT_MESSAGE);
    expect(reason({ platformAlert: "Select at least one platform." })).toBe("Select at least one platform.");
    expect(reason({ caption: "a".repeat(10_050) })).toBe(
      "Caption is too long: 10,050 / 10,000 characters.",
    );
    expect(reason({ tiktokBlock: "Choose who can see this video." })).toBe("TikTok: Choose who can see this video.");
    expect(reason({ fileBlock: "Wait until the file is ready, then press the button again." })).toBe(
      "Wait until the file is ready, then press the button again.",
    );
  });
});

describe("PublishBar", () => {
  const control = submitControl({ ...base, buttonLabel: "Publish post" });

  it("a submit button for the form, in a bar fixed to the bottom above the safe area, below md only", () => {
    const html = render(control);
    const bar = html.match(/^<div[^>]*>/)?.[0] ?? "";
    expect(bar).toContain("fixed");
    expect(bar).toContain("bottom-0");
    expect(bar).toContain("md:hidden");
    expect(bar).toContain("bg-background");
    expect(bar).toContain("border-t");
    expect(bar).toContain("env(safe-area-inset-bottom)");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*form="create-post"|<button[^>]*form="create-post"[^>]*type="submit"/);
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("the button disabled with the form's button", () => {
    const html = render(submitControl({ ...base, buttonLabel: "Publish post", caption: "a".repeat(10_001) }));
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(render(control)).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("the reason line under the button, tied to it", () => {
    const html = render(submitControl({ ...base, buttonLabel: "Publish post", platformAlert: "Select at least one platform." }));
    expect(html).toContain("Select at least one platform.");
    expect(html).toContain('aria-describedby="publish-bar-reason"');
    expect(html).toContain('id="publish-bar-reason"');
    expect(render(control)).not.toContain("publish-bar-reason");
  });

  it("hidden while a confirm dialog is open", () => {
    expect(render(control, true)).toBe("");
  });
});

// Fix round 1, item 1: TikTok's declaration must sit right before the button
// the person presses, and on a phone that is the bar's.
describe("PublishBar: TikTok's consent declaration", () => {
  const declaration = (brandedContent: boolean) =>
    renderToStaticMarkup(createElement(TikTokConsentDeclaration, { brandedContent }));
  const viewFor = (pageState: "text" | "file", mode: "now" | "schedule" | "draft") =>
    composerPageView({
      pageState,
      connected: ["tiktok", "instagram", "x"],
      deselected: new Set(),
      mimeType: pageState === "file" ? "video/mp4" : null,
      mode,
      loading: false,
      triedSend: false,
    });

  it("TikTok selected with a video: the same declaration, directly above the button, in every publish mode", () => {
    for (const mode of ["now", "schedule", "draft"] as const) {
      const view = viewFor("file", mode);
      expect(view.selected).toContain("tiktok");
      const control = submitControl({ ...base, buttonLabel: view.buttonLabel });
      for (const brandedContent of [false, true]) {
        const html = render(control, false, barTikTokDeclaration({ selected: view.selected, brandedContent }));
        const text = declaration(brandedContent);
        expect(html, mode).toContain(text);
        // Nothing between the declaration and the button but the end of its wrapper.
        expect(html.slice(html.indexOf(text) + text.length, html.indexOf("<button"))).toBe("</div>");
      }
    }
  });

  it("TikTok not selected: no line", () => {
    const control = submitControl({ ...base, buttonLabel: "Publish post" });
    expect(barTikTokDeclaration({ selected: ["instagram", "x"], brandedContent: false })).toBeNull();
    expect(render(control, false, null)).not.toContain("By posting, you agree to TikTok");
  });

  it("text only: TikTok cannot be selected, so no line", () => {
    const view = viewFor("text", "now");
    expect(view.selected).not.toContain("tiktok");
    expect(barTikTokDeclaration({ selected: view.selected, brandedContent: false })).toBeNull();
  });

  it("the bar, and so its line, is absent at md and up: the form's own line stays the one there", () => {
    const html = render(submitControl({ ...base, buttonLabel: "Publish post" }), false, { brandedContent: false });
    expect(html.match(/^<div[^>]*>/)?.[0]).toContain("md:hidden");
  });
});

// Fix round 1, item 3: the bar sat over the account menu (the header's sticky z-20 layer).
describe("PublishBar: what stays above it", () => {
  const zOf = (classes: string) => Number(classes.match(/(?:^|\s)z-\[?(\d+)\]?/)?.[1]);
  const bar = render(submitControl({ ...base, buttonLabel: "Publish post" })).match(/^<div[^>]*class="([^"]*)"/)?.[1] ?? "";
  const source = (file: string) => readFileSync(path.join(__dirname, "..", file), "utf8");

  it("the bar is on layer 10, under the header (20), dialogs and the mobile drawer (50) and toasts (60)", () => {
    expect(zOf(bar)).toBe(10);
    expect(source("shell/top-bar.tsx")).toContain("sticky top-0 z-20");
    expect(source("ui/dialog.tsx")).toContain("fixed inset-0 z-50");
    expect(source("shell/mobile-drawer.tsx")).toContain("fixed inset-0 z-50");
    expect(source("ui/toast.tsx")).toContain("z-[60]");
  });
});

// Fix round 1, item 4a: toasts sat over the bar's button for 8 seconds.
describe("toasts sit above the bar", () => {
  it("the bar publishes its height as a CSS variable: its own height while shown, 0 when hidden (md and up)", () => {
    expect(PUBLISH_BAR_OFFSET_VAR).toBe("--publish-bar-offset");
    expect(publishBarOffset(97)).toBe("97px");
    expect(publishBarOffset(0)).toBe("0px");
  });

  it("the toast container's bottom offset adds that variable, and nothing else changed", () => {
    const html = renderToStaticMarkup(createElement(ToastProvider, null, "page"));
    const container = html.match(/<div aria-live="polite"[^>]*class="([^"]*)"/)?.[1] ?? "";
    expect(container).toBe(
      "pointer-events-none fixed bottom-[calc(1rem+var(--publish-bar-offset,0px))] left-4 right-4 sm:left-auto sm:w-full sm:max-w-sm z-[60] flex flex-col gap-2",
    );
  });

  it("the lost-file toast says what to do, true on a phone and a desktop", () => {
    expect(FILE_LOST_PRESS_TOAST).toBe(
      "Nothing was sent: the photo or video could not be added. Add it again, or press the button again to post without it.",
    );
    expect(FILE_LOST_PRESS_TOAST).not.toContain("above");
  });
});
