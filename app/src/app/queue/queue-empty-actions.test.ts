import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { QueueEmptyActions, QueueView } from "./queue-view";

/**
 * R5-new-customer L6: with billing on, an empty Queue offers Add many only to
 * a workspace whose plan includes it (the bulk page itself says Growth or Pro).
 */
describe("QueueEmptyActions", () => {
  it("offers Create a post and Add many when the plan includes Add many", () => {
    const html = renderToStaticMarkup(createElement(QueueEmptyActions, { addManyIncluded: true }));
    expect(html).toMatch(/<a [^>]*href="\/posts\/new"[^>]*>Create a post<\/a>/);
    expect(html).toMatch(/<a [^>]*href="\/posts\/bulk"[^>]*>Add many<\/a>/);
  });

  it("offers only Create a post when it does not", () => {
    const html = renderToStaticMarkup(createElement(QueueEmptyActions, { addManyIncluded: false }));
    expect(html).toContain("Create a post");
    expect(html).not.toContain("/posts/bulk");
    expect(html).not.toContain("Add many");
  });

  it("the Queue takes the answer as a prop, and an older caller without it keeps Add many", () => {
    const props: Parameters<typeof QueueView>[0] = { addManyIncluded: false };
    expect(props.addManyIncluded).toBe(false);
    const html = renderToStaticMarkup(createElement(QueueEmptyActions, {}));
    expect(html).toContain("Add many");
  });
});
