import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock } = vi.hoisted(() => ({ findUniqueMock: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { workspace: { findUnique: findUniqueMock } } }));

import { findClientPageLogo } from "./clientPageLogo";

beforeEach(() => {
  findUniqueMock.mockReset();
});

describe("findClientPageLogo", () => {
  it("reads only the link's own workspace", async () => {
    findUniqueMock.mockResolvedValue({ logoUrl: "https://x.example/logos/ws-1/a.png" });
    expect(await findClientPageLogo("ws-1")).toBe("https://x.example/logos/ws-1/a.png");
    expect(findUniqueMock.mock.calls[0][0].where).toEqual({ id: "ws-1" });
    expect(findUniqueMock.mock.calls[0][0].select.logoUrl).toBe(true);
  });
  it("is null when there is no logo or no workspace", async () => {
    findUniqueMock.mockResolvedValue({ logoUrl: null });
    expect(await findClientPageLogo("ws-1")).toBeNull();
    findUniqueMock.mockResolvedValue(null);
    expect(await findClientPageLogo("ws-1")).toBeNull();
  });
  it("is null, never an error, when the read fails: the page works without a logo", async () => {
    findUniqueMock.mockImplementation(() => Promise.reject(new Error("down")));
    expect(await findClientPageLogo("ws-1")).toBeNull();
  });
});
