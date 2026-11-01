import { describe, expect, it } from "vitest";

import { composerPublishConfirmCopy } from "./composerConfirm";

describe("composerPublishConfirmCopy", () => {
  const rows: Array<
    [string, Parameters<typeof composerPublishConfirmCopy>[0], ReturnType<typeof composerPublishConfirmCopy>]
  > = [
    [
      "owner / non-approval workspace: unchanged publish-now confirmation (plural)",
      { holdsForApproval: false, platforms: ["YouTube", "TikTok"] },
      {
        title: "Publish to 2 platforms now?",
        lead: "YouTube, TikTok",
        trail: "This publishes immediately and can't be undone here.",
        confirmText: "Publish now",
      },
    ],
    [
      "owner / non-approval workspace: singular platform",
      { holdsForApproval: false, platforms: ["YouTube"] },
      {
        title: "Publish to 1 platform now?",
        lead: "YouTube",
        trail: "This publishes immediately and can't be undone here.",
        confirmText: "Publish now",
      },
    ],
    [
      "member under approval: held for review, nothing publishes yet",
      { holdsForApproval: true, platforms: ["YouTube", "TikTok"] },
      {
        title: "Submit for approval?",
        lead: "An owner will review this post before it publishes to YouTube, TikTok.",
        trail: null,
        confirmText: "Submit for approval",
      },
    ],
    [
      "member under approval, single platform",
      { holdsForApproval: true, platforms: ["Instagram"] },
      {
        title: "Submit for approval?",
        lead: "An owner will review this post before it publishes to Instagram.",
        trail: null,
        confirmText: "Submit for approval",
      },
    ],
  ];

  it.each(rows)("%s", (_name, input, expected) => {
    expect(composerPublishConfirmCopy(input)).toEqual(expected);
  });
});
