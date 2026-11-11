import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocalDay, reportDayText } from "./local-day";

// Go-live check F2 item 2: a post published on 9 November at 6:54 PM in Chicago
// is 00:54 UTC on 10 November. The screen shows the viewer's own date.
describe("reportDayText", () => {
  const chicagoEvening = "2026-11-10T00:54:00.000Z";
  const lateUtc = "2026-11-09T23:30:00.000Z";

  it("seen from Chicago, a post just after midnight UTC is the day before", () => {
    expect(reportDayText(chicagoEvening, "America/Chicago")).toBe("Nov 9, 2026");
  });

  it("seen from Berlin, a post just before midnight UTC is the day after", () => {
    expect(reportDayText(lateUtc, "Europe/Berlin")).toBe("Nov 10, 2026");
    expect(reportDayText(chicagoEvening, "Europe/Berlin")).toBe("Nov 10, 2026");
  });

  it("seen from UTC, the UTC date", () => {
    expect(reportDayText(chicagoEvening, "UTC")).toBe("Nov 10, 2026");
    expect(reportDayText(lateUtc, "UTC")).toBe("Nov 9, 2026");
  });

  it("without a zone it uses the viewer's own", () => {
    const own = new Date(chicagoEvening).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    expect(reportDayText(chicagoEvening)).toBe(own);
  });
});

describe("LocalDay", () => {
  it("renders the UTC date on the server, so the first browser render matches it", () => {
    const html = renderToStaticMarkup(createElement(LocalDay, { iso: "2026-11-10T00:54:00.000Z" }));
    expect(html).toBe('<time dateTime="2026-11-10T00:54:00.000Z">Nov 10, 2026</time>');
  });
});
