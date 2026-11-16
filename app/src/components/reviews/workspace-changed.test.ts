import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WORKSPACE_CHANGED_CODE } from "@/lib/workspaceChanged";

import { isWorkspaceChanged, WORKSPACE_CHANGED_RELOAD_MESSAGE } from "./workspace-changed";
import { COPY_BEFORE_RELOAD, WorkspaceChangedNotice } from "./workspace-changed-notice";

const source = readFileSync(path.join(__dirname, "workspace-changed-notice.tsx"), "utf8");

// R27 security-billing L1, new-customer L6: a request refused because the page
// was drawn for another workspace (409 WORKSPACE_CHANGED) says so, with Reload.
describe("workspace changed", () => {
  it("says what happened and what to do next", () => {
    expect(WORKSPACE_CHANGED_RELOAD_MESSAGE).toBe(
      "This page was opened for another workspace. Reload to see the one you're working in.",
    );
  });

  it("reads the server's code, never a sentence", () => {
    const body = (b: Record<string, unknown> | null) => b as { code?: unknown } | null;
    expect(isWorkspaceChanged(body({ code: WORKSPACE_CHANGED_CODE, error: "x" }))).toBe(true);
    expect(isWorkspaceChanged({ code: "RECONNECT_REQUIRED" })).toBe(false);
    expect(isWorkspaceChanged(body({ error: WORKSPACE_CHANGED_RELOAD_MESSAGE }))).toBe(false);
    expect(isWorkspaceChanged(null)).toBe(false);
  });

  it("the notice is a status region on the page from the first render, empty until shown", () => {
    const empty = renderToStaticMarkup(createElement(WorkspaceChangedNotice, { shown: false }));
    expect(empty).toMatch(/^<div role="status"[^>]*empty:sr-only[^>]*><\/div>$/);
    const shown = renderToStaticMarkup(createElement(WorkspaceChangedNotice, { shown: true }));
    expect(shown).toContain(WORKSPACE_CHANGED_RELOAD_MESSAGE.replace("'", "&#x27;"));
    expect(shown).toMatch(/<button[^>]*type="button"[^>]*>Reload<\/button>/);
  });

  it("Reload reloads the page", () => {
    expect(source).toContain("window.location.reload()");
  });
});

// R27 lead follow-up: Reload clears a typed reply, so after a refused reply or
// draft the notice says to copy it first.
describe("workspace changed: the copy hint", () => {
  it("says to copy anything typed when a press was refused", () => {
    expect(COPY_BEFORE_RELOAD).toBe("Copy anything you typed, then reload.");
    const html = renderToStaticMarkup(createElement(WorkspaceChangedNotice, { shown: true, copyHint: true }));
    expect(html).toContain(COPY_BEFORE_RELOAD);
    expect(html.indexOf(COPY_BEFORE_RELOAD)).toBeLessThan(html.indexOf(">Reload</button>"));
  });

  it("not when only the page's loads were refused", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceChangedNotice, { shown: true }));
    expect(html).not.toContain(COPY_BEFORE_RELOAD);
  });
});
