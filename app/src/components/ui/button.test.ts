import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Button, type ButtonProps } from "./button";

/**
 * R25 pages L6: a Button that disabled itself while loading dropped keyboard
 * focus to the page body. While loading it now stays focusable and says it is
 * unavailable (aria-disabled, aria-busy); a press does nothing, so a submit
 * button can't submit (Enter in a field clicks the form's submit button, and a
 * cancelled click submits nothing). An explicit `disabled` is still the real
 * attribute.
 */
const render = (props: ButtonProps) => renderToStaticMarkup(createElement(Button, props, "Save"));

/** The <button> element Button renders, so its click handler can be called. */
function buttonElement(props: ButtonProps): ReactElement<Record<string, unknown>> {
  const inner = (Button as unknown as { render: (p: ButtonProps, ref: null) => ReactElement<Record<string, unknown>> })
    .render;
  return inner({ children: "Save", ...props }, null);
}

describe("Button while loading", () => {
  it("keeps focus: no disabled attribute, but aria-disabled and aria-busy", () => {
    const html = render({ loading: true });
    expect(html).not.toMatch(/\sdisabled=""/);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
  });

  it("a press does nothing: the default is prevented and onClick is not called", () => {
    const onClick = vi.fn();
    const element = buttonElement({ loading: true, type: "submit", onClick });
    const preventDefault = vi.fn();
    (element.props.onClick as (event: unknown) => void)({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("an explicit disabled keeps the real attribute, loading or not", () => {
    expect(render({ disabled: true })).toMatch(/\sdisabled=""/);
    expect(render({ disabled: true, loading: true })).toMatch(/\sdisabled=""/);
  });

  it("looks unavailable while loading, as a disabled button does", () => {
    const html = render({ loading: true });
    expect(html).toMatch(/class="[^"]*\sopacity-50[\s"]/);
    expect(render({})).not.toMatch(/class="[^"]*\sopacity-50[\s"]/);
  });

  it("not loading: no aria-disabled, and a press reaches onClick", () => {
    const html = render({});
    expect(html).not.toMatch(/\saria-disabled=/);
    expect(html).not.toMatch(/\saria-busy=/);
    const onClick = vi.fn();
    const element = buttonElement({ onClick });
    const preventDefault = vi.fn();
    (element.props.onClick as (event: unknown) => void)({ preventDefault });
    expect(onClick).toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
