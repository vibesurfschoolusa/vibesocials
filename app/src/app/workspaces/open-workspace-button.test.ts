import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * R27 MM3 (new-customer L7): offline, Open said "Couldn't open that workspace.
 * Try again." where the account menu's switch says the connection sentence. It
 * sends through fetchOrNoAnswer and says a failure as the menu does.
 */
describe("Workspaces page Open", () => {
  const source = readFileSync(fileURLToPath(new URL("./open-workspace-button.tsx", import.meta.url)), "utf8");

  it("sends through fetchOrNoAnswer", () => {
    expect(source).toMatch(/await fetchOrNoAnswer\("\/api\/workspaces\/switch"/);
    expect(source).not.toMatch(/await fetch\(/);
  });

  it("says a failure with the dialogs' sentences, as the menu's switch", () => {
    expect(source).toMatch(/catch \(error\) \{\s+const text = confirmFailureText\(error\);\s+if \(text\) toast\.error\(text\);/);
    expect(source).not.toMatch(/catch \{/);
  });
});
