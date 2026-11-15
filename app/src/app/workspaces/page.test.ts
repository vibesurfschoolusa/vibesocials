import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWorkspaceContextMock, getWorkspacesOverviewMock, redirectMock } = vi.hoisted(() => ({
  getWorkspaceContextMock: vi.fn(),
  getWorkspacesOverviewMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("@/lib/workspace", () => ({ getWorkspaceContext: getWorkspaceContextMock }));
vi.mock("@/server/overview/workspaceOverview", () => ({
  getWorkspacesOverview: getWorkspacesOverviewMock,
}));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));
// The button is a client component that needs the toast provider; its label is enough here.
vi.mock("./open-workspace-button", () => ({
  OpenWorkspaceButton: ({ name }: { name: string }) =>
    createElement("button", { type: "button" }, `Open ${name}`),
}));

import WorkspacesPage from "./page";
import type { WorkspaceOverviewEntry } from "@/server/overview/workspaceOverview";

function entry(overrides: Partial<WorkspaceOverviewEntry> = {}): WorkspaceOverviewEntry {
  return {
    workspaceId: "ws-1",
    name: "Calm Co",
    role: "owner",
    postsThisMonth: 0,
    scheduled: 0,
    waitingForApproval: 0,
    clientChangesRequested: 0,
    chooseGoogleLocation: false,
    failedLast7Days: 0,
    failedPlatforms: [],
    needsReconnect: [],
    endsSoon: [],
    ended: [],
    connected: 0,
    needsAttention: false,
    ...overrides,
  };
}

async function render(): Promise<string> {
  return renderToStaticMarkup((await WorkspacesPage()) as ReactElement);
}

beforeEach(() => {
  getWorkspaceContextMock.mockReset();
  getWorkspacesOverviewMock.mockReset();
  redirectMock.mockClear();
  getWorkspaceContextMock.mockResolvedValue({
    user: { id: "user-1" },
    workspace: { id: "ws-1" },
    role: "owner",
  });
});

describe("WorkspacesPage", () => {
  it("sends a signed-out visitor to the login page", async () => {
    getWorkspaceContextMock.mockResolvedValue(null);

    await expect(WorkspacesPage()).rejects.toThrow("redirect:/login?callbackUrl=%2Fworkspaces");
    expect(getWorkspacesOverviewMock).not.toHaveBeenCalled();
  });

  it("loads the overview for the signed-in user only", async () => {
    getWorkspacesOverviewMock.mockResolvedValue([entry()]);

    await render();

    expect(getWorkspacesOverviewMock).toHaveBeenCalledWith("user-1", expect.any(Date));
  });

  it("says in one line when nothing needs attention", async () => {
    getWorkspacesOverviewMock.mockResolvedValue([entry()]);

    const html = await render();

    expect(html).toContain("Nothing needs your attention in any workspace.");
    expect(html).not.toContain("Needs attention");
  });

  it("marks the active workspace and the ones needing attention, with their details", async () => {
    getWorkspacesOverviewMock.mockResolvedValue([
      entry({
        workspaceId: "ws-2",
        name: "Busy Co",
        role: "member",
        waitingForApproval: 2,
        failedLast7Days: 3,
        failedPlatforms: ["x", "instagram"],
        needsReconnect: ["linkedin"],
        connected: 3,
        needsAttention: true,
      }),
      entry(),
    ]);

    const html = await render();

    expect(html).not.toContain("Nothing needs your attention");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Active");
    expect(html).toContain("Member");
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("Failed in the last 7 days");
    expect(html).toContain("X, Instagram");
    expect(html).toContain("Needs reconnecting");
    expect(html).toContain("LinkedIn");
    expect(html).toContain("Open Busy Co");
    expect(html.indexOf("Busy Co")).toBeLessThan(html.indexOf("Calm Co"));
  });

  it("names a client's change requests and a Google listing without a location (R5-client-journey L1)", async () => {
    getWorkspacesOverviewMock.mockResolvedValue([
      entry({ clientChangesRequested: 2, chooseGoogleLocation: true, needsAttention: true }),
    ]);

    const html = await render();

    expect(html).not.toContain("Nothing needs your attention");
    expect(html).toContain("A client asked for changes on 2 posts. Open the workspace, then the Queue.");
    expect(html).toContain(
      "Choose the Google business location: open the workspace, then Settings, Connections.",
    );
  });

  it("says one post when a client asked for changes on one", async () => {
    getWorkspacesOverviewMock.mockResolvedValue([entry({ clientChangesRequested: 1, needsAttention: true })]);

    expect(await render()).toContain("A client asked for changes on 1 post.");
  });
});

// R6-client-journey L4: only an owner decides approvals, so the number is red
// for an owner only (as Needs you, which gives a member no approvals row).
describe("WorkspacesPage: waiting for approval", () => {
  it("shows the number in red to an owner, plainly to a member", async () => {
    getWorkspacesOverviewMock.mockResolvedValue([
      entry({ workspaceId: "ws-owner", name: "Owner Co", role: "owner", waitingForApproval: 3, needsAttention: true }),
      entry({ workspaceId: "ws-member", name: "Member Co", role: "member", waitingForApproval: 2 }),
    ]);

    const html = await render();

    expect(html).toMatch(/text-danger-ontint">3</);
    expect(html).not.toMatch(/text-danger-ontint">2</);
    expect(html).toMatch(/text-foreground">2</);
  });
});

// R7-pages L4 / client-journey L3: the warning window and the end, named per workspace.
describe("WorkspacesPage: connections that end", () => {
  it("names the connections that end soon and those that ended, with what to do", async () => {
    getWorkspacesOverviewMock.mockResolvedValue([
      entry({ endsSoon: ["linkedin"], ended: ["x"], needsAttention: true }),
    ]);

    const html = await render();

    expect(html).not.toContain("Nothing needs your attention");
    expect(html).toContain("Ends soon:</span> LinkedIn. Reconnect it in Settings, Connections.");
    expect(html).toContain("Ended:</span> X. Reconnect it in Settings, Connections.");
  });

  it("healthy: no such line", async () => {
    getWorkspacesOverviewMock.mockResolvedValue([entry()]);
    const html = await render();
    expect(html).not.toContain("Ends soon");
    expect(html).not.toContain("Ended:");
  });
});
