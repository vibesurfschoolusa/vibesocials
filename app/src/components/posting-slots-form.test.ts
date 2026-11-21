import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

import { PostingSlotsForm } from "./posting-slots-form";

// R56 new-customer-2 L3: each row's controls repeat, so each is named by its row.
describe("PostingSlotsForm: row controls name their row", () => {
  const html = renderToStaticMarkup(
    createElement(PostingSlotsForm, {
      workspaceId: "ws-1",
      role: "owner",
      slots: [
        { day: 2, time: "09:00" },
        { day: 5, time: "18:30" },
      ],
    }),
  );

  it("gives the two rows different names that say which row", () => {
    expect(html).toContain('aria-label="Weekday, time 1"');
    expect(html).toContain('aria-label="Weekday, time 2"');
    expect(html).toContain('aria-label="Time, time 1"');
    expect(html).toContain('aria-label="Time, time 2"');
    expect(html).toContain('aria-label="Remove Tuesday at 09:00"');
    expect(html).toContain('aria-label="Remove Friday at 18:30"');
  });

  it("keeps the visible text of Remove", () => {
    expect(html.match(/>Remove</g)).toHaveLength(2);
  });
});
