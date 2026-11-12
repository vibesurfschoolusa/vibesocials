import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { composerPageView, submitButtonLabel, submitControl, UNTOUCHED_SUBMIT_MESSAGE } from "../create-post-form";
import { PublishBar } from "./publish-bar";

const base = {
  loading: false,
  caption: "hello",
  tiktokBlock: null,
  fileBlock: null,
  untouchedMessage: null,
  platformAlert: null,
};

const render = (control: ReturnType<typeof submitControl>, dialogOpen = false) =>
  renderToStaticMarkup(createElement(PublishBar, { formId: "create-post", control, dialogOpen }));

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
