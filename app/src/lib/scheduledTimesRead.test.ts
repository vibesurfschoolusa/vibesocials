import { describe, expect, it, vi } from "vitest";

import { readScheduledTimes } from "./scheduledTimesRead";
import { renderedWorkspaceRefusal, WORKSPACE_CHANGED_SAVE_MESSAGE } from "./workspaceChanged";

// R32 new-customer L3: Create's "Next free slot" and Add many's posting times
// read the page's workspace only; a refusal says the shared sentence.
describe("readScheduledTimes", () => {
  it("asks for the page's workspace and gives its posting times and taken times", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ times: ["2026-11-20T09:00:00.000Z"], slots: [{ day: 4, time: "09:00" }] }),
    );
    await expect(readScheduledTimes("ws-1", fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      slots: [{ day: 4, time: "09:00" }],
      taken: [new Date("2026-11-20T09:00:00.000Z")],
    });
    expect(String((fetchImpl.mock.calls as unknown as [string][])[0][0])).toBe("/api/posts/scheduled-times?workspaceId=ws-1");
  });

  it("an answer without lists is no times", async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    await expect(readScheduledTimes("ws-1", fetchImpl as unknown as typeof fetch)).resolves.toEqual({ slots: [], taken: [] });
  });

  it("a refusal: the switch sentence, never the other workspace's times", async () => {
    const fetchImpl = vi.fn(async () => renderedWorkspaceRefusal("ws-1", "ws-2") as Response);
    await expect(readScheduledTimes("ws-1", fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      refused: WORKSPACE_CHANGED_SAVE_MESSAGE,
    });
  });

  it("any other failure is 'error' (the button stays hidden, as before)", async () => {
    const failing = vi.fn(async () => Response.json({ error: "x" }, { status: 500 }));
    await expect(readScheduledTimes("ws-1", failing as unknown as typeof fetch)).resolves.toBe("error");
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(readScheduledTimes("ws-1", offline as unknown as typeof fetch)).resolves.toBe("error");
  });
});
