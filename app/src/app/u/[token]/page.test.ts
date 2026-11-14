import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findActiveUploadLinkMock, formPropsMock, findLogoMock } = vi.hoisted(() => ({
  findLogoMock: vi.fn(),
  findActiveUploadLinkMock: vi.fn(),
  formPropsMock: vi.fn(),
}));

vi.mock("@/lib/clientPageLogo", () => ({ findClientPageLogo: findLogoMock }));
vi.mock("@/server/uploadLink", () => ({ findActiveUploadLink: findActiveUploadLinkMock }));
// The form is a client component; what the page hands it is what matters here.
vi.mock("./upload-link-form", () => ({
  UploadLinkForm: (props: Record<string, unknown>) => {
    formPropsMock(props);
    return createElement("form", null, "form");
  },
}));

import { UPLOAD_LINK_INACTIVE_MESSAGE } from "@/lib/uploadLink";

import UploadLinkPage from "./page";

const TOKEN = "T".repeat(43);

async function render(token = TOKEN): Promise<string> {
  return renderToStaticMarkup(
    (await UploadLinkPage({ params: Promise.resolve({ token }) })) as ReactElement,
  );
}

beforeEach(() => {
  findActiveUploadLinkMock.mockReset();
  formPropsMock.mockReset();
  findLogoMock.mockReset();
  findLogoMock.mockResolvedValue(null);
});

describe("the upload link page", () => {
  it("shows an unknown and a revoked link identically, with only the sentence", async () => {
    // findActiveUploadLink gives null for both (src/server/uploadLink.test.ts).
    findActiveUploadLinkMock.mockResolvedValue(null);
    const unknown = await render("unknown");
    const revoked = await render(TOKEN);

    expect(unknown).toBe(revoked);
    expect(unknown).toContain(UPLOAD_LINK_INACTIVE_MESSAGE);
    expect(unknown).not.toContain("<form");
    expect(formPropsMock).not.toHaveBeenCalled();
  });

  it("names the workspace and hands the form only the token and the name", async () => {
    findActiveUploadLinkMock.mockResolvedValue({
      id: "link-1",
      workspaceId: "ws-1",
      createdById: "owner-1",
      workspaceName: "Surf & Co",
    });

    const html = await render();

    expect(findActiveUploadLinkMock).toHaveBeenCalledWith(TOKEN);
    expect(html).toContain("Surf &amp; Co");
    expect(html).toMatch(/<h1[^>]*>Send photos and videos<\/h1>/);
    expect(findLogoMock).toHaveBeenCalledWith("ws-1");
    expect(formPropsMock).toHaveBeenCalledWith({ token: TOKEN });
    expect(html).not.toContain("ws-1");
    expect(html).not.toContain("link-1");
    expect(html).not.toContain("owner-1");
  });

  it("shows the workspace logo, and the product name on an inactive link", async () => {
    findLogoMock.mockResolvedValue("https://x.example/logos/ws-1/a.png");
    findActiveUploadLinkMock.mockResolvedValue({ id: "l", workspaceId: "ws-1", createdById: "o", workspaceName: "Surf" });
    expect(await render()).toContain('src="https://x.example/logos/ws-1/a.png"');
    findActiveUploadLinkMock.mockResolvedValue(null);
    expect(await render()).toContain("Vibe Socials");
  });
});
