import { describe, expect, it } from "vitest";

import { connectionStepSentence, stepForCode, stepsForRows, stepVerb } from "./connectionSteps";

describe("stepForCode: the failed row's code names the step", () => {
  it("CONNECTION_GONE is connect, RECONNECT_REQUIRED is reconnect, anything else none", () => {
    expect(stepForCode("CONNECTION_GONE")).toBe("connect");
    expect(stepForCode("RECONNECT_REQUIRED")).toBe("reconnect");
    expect(stepForCode("PUBLISH_STALLED")).toBeNull();
    expect(stepForCode(null)).toBeNull();
  });

  it("stepsForRows keeps one step per platform, from failed rows only", () => {
    expect(
      stepsForRows([
        { platform: "x", status: "failed", errorCode: "CONNECTION_GONE" },
        { platform: "x", status: "failed", errorCode: "CONNECTION_GONE" },
        { platform: "instagram", status: "failed", errorCode: "RECONNECT_REQUIRED" },
        { platform: "youtube", status: "failed", errorCode: "PUBLISH_STALLED" },
        { platform: "linkedin", status: "success", errorCode: null },
      ]),
    ).toEqual([
      { platform: "x", step: "connect" },
      { platform: "instagram", step: "reconnect" },
    ]);
  });
});

describe("connectionStepSentence: a failed row's stored sentence", () => {
  it("flagged: the sentence the rows always had", () => {
    expect(connectionStepSentence({ form: "row", platform: "instagram", step: "reconnect" }, "owner")).toBe(
      "Reconnect Instagram in Settings, then retry.",
    );
    expect(connectionStepSentence({ form: "row", platform: "instagram", step: "reconnect" }, "member")).toBe(
      "The workspace owner can reconnect Instagram; then retry.",
    );
  });

  it("gone: Connect, as Settings offers only Connect", () => {
    expect(connectionStepSentence({ form: "row", platform: "x", step: "connect" }, "owner")).toBe(
      "X is no longer connected. Connect it in Settings, then retry.",
    );
    expect(connectionStepSentence({ form: "row", platform: "x", step: "connect" }, "member")).toBe(
      "The workspace owner can connect X; then retry.",
    );
  });
});

describe("connectionStepSentence: Retry's answers (#293, unchanged)", () => {
  it("connect and reconnect, owner and member", () => {
    const platforms = ["instagram", "facebook_page"] as const;
    expect(connectionStepSentence({ form: "retry", platforms, step: "connect" }, "owner")).toBe(
      "Connect Instagram and Facebook Page in Settings, then retry.",
    );
    expect(connectionStepSentence({ form: "retry", platforms, step: "connect" }, "member")).toBe(
      "The workspace owner can connect Instagram and Facebook Page; then retry.",
    );
    expect(connectionStepSentence({ form: "retry", platforms, step: "reconnect" }, "owner")).toBe(
      "Reconnect Instagram and Facebook Page in Settings before retrying.",
    );
    expect(connectionStepSentence({ form: "retry", platforms, step: "reconnect" }, "member")).toBe(
      "The workspace owner can reconnect Instagram and Facebook Page; then retry.",
    );
  });

  it("Retry all's left-out platform", () => {
    expect(connectionStepSentence({ form: "leftOut", platform: "x", step: "connect" }, "owner")).toBe(
      "X left out: connect it in Settings.",
    );
    expect(connectionStepSentence({ form: "leftOut", platform: "x", step: "reconnect" }, "member")).toBe(
      "X left out: the workspace owner can reconnect it.",
    );
  });

  it("the outcome email's row", () => {
    expect(connectionStepSentence({ form: "emailRow", platform: "x", step: "connect" }, "owner")).toBe(
      "Connect X in Settings, then retry it in Activity.",
    );
    expect(connectionStepSentence({ form: "emailRow", platform: "x", step: "reconnect" }, "owner")).toBe(
      "Reconnect X in Settings, then retry it in Activity.",
    );
    expect(connectionStepSentence({ form: "emailRow", platform: "x", step: "connect" }, "member")).toBe(
      "The workspace owner can connect X; then retry it in Activity.",
    );
  });
});

describe("connectionStepSentence: Post now in the composer, each platform named with its step", () => {
  const steps = [
    { platform: "instagram", step: "reconnect" },
    { platform: "x", step: "connect" },
    { platform: "youtube", step: "reconnect" },
  ] as const;

  it("mixed", () => {
    expect(connectionStepSentence({ form: "composer", steps }, "owner")).toBe(
      "Reconnect Instagram and YouTube, and connect X, in Settings, then use Retry in Activity.",
    );
    expect(connectionStepSentence({ form: "composer", steps }, "member")).toBe(
      "The workspace owner can reconnect Instagram and YouTube, and connect X; then use Retry in Activity.",
    );
  });

  it("one reason", () => {
    expect(connectionStepSentence({ form: "composer", steps: [{ platform: "x", step: "connect" }] }, "owner")).toBe(
      "Connect X in Settings, then use Retry in Activity.",
    );
  });
});

describe("connectionStepSentence: nothing went out, Activity lists the platforms", () => {
  it("all gone: connect", () => {
    expect(connectionStepSentence({ form: "activity", steps: ["connect", "connect"] }, "owner")).toBe(
      "Activity shows what to connect.",
    );
    expect(connectionStepSentence({ form: "activity", steps: ["connect"] }, "member")).toBe(
      "Activity shows what didn't go out; the workspace owner can connect it.",
    );
  });

  it("all flagged: reconnect, the wording it always had", () => {
    expect(connectionStepSentence({ form: "activity", steps: ["reconnect"] }, "owner")).toBe(
      "Activity shows what to reconnect.",
    );
    expect(connectionStepSentence({ form: "activity", steps: ["reconnect"] }, "member")).toBe(
      "Activity shows what didn't go out; the workspace owner can reconnect it.",
    );
  });

  it("mixed, or the codes not known: connect or reconnect", () => {
    for (const steps of [["connect", "reconnect"], []] as const) {
      expect(connectionStepSentence({ form: "activity", steps }, "owner")).toBe(
        "Activity shows what to connect or reconnect.",
      );
      expect(connectionStepSentence({ form: "activity", steps }, "member")).toBe(
        "Activity shows what didn't go out; the workspace owner can connect or reconnect it.",
      );
    }
  });

  it("in an email", () => {
    expect(connectionStepSentence({ form: "activityEmail", steps: ["reconnect"] }, "member")).toBe(
      "The workspace owner can reconnect them in Settings; Activity shows which.",
    );
    expect(connectionStepSentence({ form: "activityEmail", steps: ["connect"] }, "member")).toBe(
      "The workspace owner can connect them in Settings; Activity shows which.",
    );
    expect(connectionStepSentence({ form: "activityEmail", steps: ["connect", "reconnect"] }, "member")).toBe(
      "The workspace owner can connect or reconnect them in Settings; Activity shows which.",
    );
    expect(connectionStepSentence({ form: "activityEmail", steps: ["connect"] }, "owner")).toBe(
      "Connect them in Settings; Activity shows which.",
    );
  });
});

describe("the Activity card's pieces (R59 follow-up)", () => {
  it("a Retry all refusal that lists no platform names what the card asked for", () => {
    const sentence = { form: "retry", platforms: [], unnamed: "the failed platforms" } as const;
    expect(connectionStepSentence({ ...sentence, step: "connect" }, "owner")).toBe(
      "Connect the failed platforms in Settings, then retry.",
    );
    expect(connectionStepSentence({ ...sentence, step: "reconnect" }, "member")).toBe(
      "The workspace owner can reconnect the failed platforms; then retry.",
    );
    expect(connectionStepSentence({ form: "retry", platforms: ["x"], unnamed: "unused", step: "reconnect" }, "owner")).toBe(
      "Reconnect X in Settings before retrying.",
    );
  });

  it("the step's verb, for a sentence whose Settings is a link", () => {
    expect(stepVerb("connect")).toBe("Connect");
    expect(stepVerb("reconnect")).toBe("Reconnect");
  });
});
