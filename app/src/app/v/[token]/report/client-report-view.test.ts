import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// R12-pages L6: the page has an h1 before the report arrives and when it
// fails to load. The tests run without a DOM, so the view's state is forced
// through useState: its first state is the report, its second the error.
const forced = vi.hoisted(() => ({ error: undefined as string | undefined, calls: 0 }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      forced.calls += 1;
      if (forced.calls % 2 === 0 && forced.error !== undefined) return [forced.error, () => {}];
      return actual.useState(initial);
    },
  };
});

import { ClientReportView } from "./client-report-view";

function view(): string {
  forced.calls = 0;
  return renderToStaticMarkup(createElement(ClientReportView, { token: "T".repeat(43), month: "2026-10" }));
}

afterEach(() => {
  forced.error = undefined;
});

describe("ClientReportView", () => {
  it("has an h1 while the report loads", () => {
    const html = view();
    expect(html).toContain("Loading the report");
    expect(html).toMatch(/<h1[^>]*>Monthly report<\/h1>/);
  });

  it("has an h1 when the report failed to load", () => {
    forced.error = "";
    const html = view();
    expect(html).toContain("Couldn&#x27;t load the report.");
    expect(html).toMatch(/<h1[^>]*>Monthly report<\/h1>/);
  });
});
