import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/components/dashboard/dashboard-home", () => ({ DashboardHome: () => null }));
vi.mock("@/components/landing", () => ({ Landing: () => null }));

import HomePage from "./page";

afterEach(() => {
  vi.unstubAllEnvs();
});

// Go-live check 2026-11-11: the dashboard gets the platforms this site offers,
// so its YouTube card names Pinterest only where Pinterest is configured.
describe("HomePage — signed in", () => {
  it("passes the site's platforms without Pinterest when it is not configured", async () => {
    vi.stubEnv("PINTEREST_APP_ID", "");
    const element = (await HomePage()) as { props: { availablePlatforms: string[] } };
    expect(element.props.availablePlatforms).not.toContain("pinterest");
    expect(element.props.availablePlatforms).toContain("instagram");
  });

  it("includes Pinterest when its app is configured", async () => {
    vi.stubEnv("PINTEREST_APP_ID", "app");
    vi.stubEnv("PINTEREST_APP_SECRET", "test-secret");
    vi.stubEnv("PINTEREST_REDIRECT_URI", "https://example.test/callback");
    const element = (await HomePage()) as { props: { availablePlatforms: string[] } };
    expect(element.props.availablePlatforms).toContain("pinterest");
  });
});
