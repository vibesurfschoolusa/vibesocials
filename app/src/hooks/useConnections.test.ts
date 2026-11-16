import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderedWorkspaceRefusal, WORKSPACE_CHANGED_SAVE_MESSAGE } from "@/lib/workspaceChanged";

import {
  CONNECTIONS_FAILED_TEXT,
  CONNECTIONS_OFFLINE_TEXT,
  useConnections,
  type UseConnectionsResult,
} from "./useConnections";

// R26 LL3 item 4: Create showed the browser's own error text ("Failed to
// fetch", "Load failed", "Unexpected token '<'") in front of its sentence.
// The hook now says one of its own sentences. Mounted with react-dom/client
// against a stub container, as usePostJobs.test.ts does (no DOM library).

let latest: UseConnectionsResult;
let root: Root | null = null;
const fetchMock = vi.fn();

let probeWorkspaceId: string | null = "ws-1";

function Probe() {
  const result = useConnections(probeWorkspaceId);
  useEffect(() => {
    latest = result;
  });
  return null;
}

async function mount() {
  const container = { nodeType: 9, addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Probe));
  });
  await act(async () => {});
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  probeWorkspaceId = "ws-1";
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("window", { event: undefined, document: {}, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("useConnections failures", () => {
  it("offline: the connection sentence, not the browser's text", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await mount();
    expect(latest.error).toBe(CONNECTIONS_OFFLINE_TEXT);
    expect(CONNECTIONS_OFFLINE_TEXT).toBe(
      "We couldn't reach Vibe Socials to load your connections. Check your connection and try again.",
    );
  });

  it("a 5xx: the fixed sentence", async () => {
    fetchMock.mockResolvedValue(new Response("<html>oops</html>", { status: 502 }));
    await mount();
    expect(latest.error).toBe(CONNECTIONS_FAILED_TEXT);
    expect(CONNECTIONS_FAILED_TEXT).toBe("We couldn't load your connections. Try again in a moment.");
  });

  it("a 200 that isn't JSON: the fixed sentence, not the parser's", async () => {
    fetchMock.mockResolvedValue(new Response("<!doctype html><html></html>", { status: 200 }));
    await mount();
    expect(latest.error).toBe(CONNECTIONS_FAILED_TEXT);
    expect(latest.connections).toBeNull();
  });

  it("a 200 JSON without the list: the fixed sentence", async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    await mount();
    expect(latest.error).toBe(CONNECTIONS_FAILED_TEXT);
  });

  it("signed out: the shared signed-out sentence", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 }));
    await mount();
    expect(latest.error).toBe("You were signed out. Sign in again.");
  });

  it("a good answer: the list, no error", async () => {
    fetchMock.mockResolvedValue(Response.json({ connections: [{ platform: "x", connected: true }] }));
    await mount();
    expect(latest.error).toBeNull();
    expect(latest.connections).toHaveLength(1);
  });
});

// R32 publishing L1: the read names the page's workspace; a refusal says the
// shared sentence instead of another workspace's connections.
describe("useConnections and the page's workspace", () => {
  it("sends the page's id", async () => {
    fetchMock.mockResolvedValue(Response.json({ connections: [] }));
    await mount();
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/connections?workspaceId=ws-1");
  });

  it("sends none for a page that couldn't read its workspace (the route's reload sentence)", async () => {
    probeWorkspaceId = null;
    fetchMock.mockResolvedValue(Response.json({ connections: [] }));
    await mount();
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/connections");
  });

  it("a refusal: the switch sentence, no list", async () => {
    fetchMock.mockResolvedValue(renderedWorkspaceRefusal("ws-1", "ws-2"));
    await mount();
    expect(latest.error).toBe(WORKSPACE_CHANGED_SAVE_MESSAGE);
    expect(latest.connections).toBeNull();
  });
});
