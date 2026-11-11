import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { LOGO_HELP_LINE } from "@/lib/workspaceLogo";

import { WorkspaceLogoControl } from "./workspace-logo-control";

const LOGO = "https://abc.public.blob.vercel-storage.com/logos/ws-1/0123456789abcdef.png";

const render = (logoUrl: string | null, isOwner: boolean) =>
  renderToStaticMarkup(createElement(WorkspaceLogoControl, { logoUrl, isOwner, workspaceId: "ws-1" }));

describe("WorkspaceLogoControl", () => {
  it("shows an owner the logo, Upload, Remove and the one line", () => {
    const html = render(LOGO, true);
    expect(html).toContain(">Logo<");
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).toContain(">Upload<");
    expect(html).toContain(">Remove<");
    expect(html).toContain(LOGO_HELP_LINE);
    expect(html).toContain('accept="image/png,image/jpeg"');
  });

  it("offers an owner with no logo only Upload", () => {
    const html = render(null, true);
    expect(html).toContain(">Upload<");
    expect(html).not.toContain(">Remove<");
    expect(html).not.toContain("<img");
    expect(html).toContain("No logo yet.");
  });

  it("shows a member the logo and no buttons", () => {
    const html = render(LOGO, false);
    expect(html).toContain(`src="${LOGO}"`);
    expect(html).not.toContain(">Upload<");
    expect(html).not.toContain(">Remove<");
    expect(html).not.toContain('type="file"');
  });
});
