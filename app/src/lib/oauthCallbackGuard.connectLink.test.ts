import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCurrentUserMock } = vi.hoisted(() => ({ getCurrentUserMock: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { ConnectLinkFlow } from "./connectLink";
import { guardOAuthCallbackSession } from "./oauthCallbackGuard";

const ORIGIN = "https://app.example.com";
const LINK: ConnectLinkFlow = { id: "link-1", nonce: "n", userId: "user-creator", workspaceId: "ws-1", token: "T".repeat(43) };

beforeEach(() => getCurrentUserMock.mockReset());

describe("guardOAuthCallbackSession with a connect link", () => {
  it("asks for no session and lets the flow on when the state names the link's creator", async () => {
    const res = await guardOAuthCallbackSession({ platform: "tiktok", stateUserId: "user-creator", baseUrl: ORIGIN, link: LINK });
    expect(res).toBeNull();
    expect(getCurrentUserMock).not.toHaveBeenCalled();
  });

  it("answers the mismatch redirect when the state names someone else", async () => {
    const res = await guardOAuthCallbackSession({ platform: "tiktok", stateUserId: "user-other", baseUrl: ORIGIN, link: LINK });
    expect(res?.headers.get("location")).toBe(`${ORIGIN}/settings?error=oauth_session_mismatch`);
    expect(getCurrentUserMock).not.toHaveBeenCalled();
  });

  it("with link null is today's session check", async () => {
    getCurrentUserMock.mockResolvedValue(null);
    const res = await guardOAuthCallbackSession({ platform: "tiktok", stateUserId: "user-creator", baseUrl: ORIGIN, link: null });
    expect(res?.headers.get("location")).toBe(`${ORIGIN}/login?callbackUrl=%2Fsettings`);
    expect(getCurrentUserMock).toHaveBeenCalledTimes(1);
  });
});
