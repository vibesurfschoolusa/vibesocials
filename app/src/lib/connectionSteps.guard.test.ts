import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * R59 (publishing-flow L1, pages-a L1): what to do about a platform's
 * connection in a post's send is worded by lib/connectionSteps.ts alone. The
 * Connect versus Reconnect rule was patched in place twice (#293, then R59),
 * each time in sentences someone had worded by hand, so this guard reads every
 * text in the files on the publish path and fails on one that words a connect
 * or reconnect step itself. Text a file must keep (a stored sentence old rows
 * still carry, a platform client's sentence matched by its exact words, a
 * reason the step is always the same for) is listed below with why, so a new
 * one is a decision, not an accident.
 */

const SRC = path.join(__dirname, "..");

/**
 * A text that tells its reader to connect or reconnect ("connected",
 * "connection" and "reconnecting" describe, so they don't match), or that puts
 * a step word it was handed before "in Settings" or after "owner can", or
 * right before the platform and then the retry ("${step} ${label}, then retry").
 */
const STEP =
  /\b(?:re)?connect\b(?!_)|\breconnected in Settings\b|\$\{\}[^.;]*\bin Settings\b|\bowner can \$\{\}|\$\{\} \$\{\}(?:, then retry|; then)/i;
/** The step's own codes ("connect" | "reconnect"), compared in code, never shown. */
const CODE = /^(?:re)?connect$/;
/** Never read by a person: a log line's "[tag] ..." and an id such as a step's "notify-gbp-reconnect-${}". */
const NOT_SHOWN = /^\[|^\S*-\S*$/;

/** Every string, template and JSX text in a file; a template's expressions read as ${}. */
function textsOf(fileName: string, source: string): string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const texts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) texts.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      texts.push(node.head.text + node.templateSpans.map((span) => `\${}${span.literal.text}`).join(""));
    } else if (ts.isJsxText(node) && node.text.trim() !== "") texts.push(node.text.trim());
    ts.forEachChild(node, visit);
  };
  visit(file);
  return texts;
}

/** The texts in `source` that word a connect or reconnect step. */
function stepTexts(fileName: string, source: string): string[] {
  return textsOf(fileName, source).filter((text) => STEP.test(text) && !CODE.test(text) && !NOT_SHOWN.test(text));
}

const CARD_OWNER = "AT2 owns the card; the same words as the helper's retry and row forms, to move into it";

/**
 * The publish path, and the step texts each file may still hold, with why. An
 * entry no longer in its file fails too, so the list stays true.
 */
const PUBLISH_PATH: Record<string, Record<string, string>> = {
  "lib/ownerStepAnswers.ts": {
    "Connect your social accounts so Vibe Socials can publish on your behalf.": "Settings' Connections intro, not a post's send",
  },
  "lib/retryAll.ts": {},
  "lib/publishFailureText.ts": {
    "This platform needs to be reconnected in Settings before publishing.":
      "publishToPlatform's flagged row (inngest-functions.ts), matched here for its member form",
    "This platform is no longer connected. Reconnect it in Settings and try again.":
      "the retry run's row before R59; old rows keep it, matched here for its member form",
    "This platform connection was removed. Reconnect and retry.":
      "CONNECTION_GONE_FAILURE's row before R59, and connectionRefresh's error text; old rows keep it",
    "The workspace owner can reconnect ${} and choose a board; then retry.": "Pinterest's board sentences: the connection exists, so always reconnect",
    "The Pinterest board this connection posts to no longer exists. Reconnect Pinterest in Settings and choose a board.":
      "pinterestClient's sentence, matched by its words",
    "No Pinterest board is chosen for this connection. Reconnect Pinterest in Settings and choose a board.":
      "pinterestClient's sentence, matched by its words",
    "LinkedIn refused the post because the connected LinkedIn account is not a Super admin of this company page. A Super admin of the page can add that account as a Super admin (Page admin tools > Manage admins); then the workspace owner can reconnect LinkedIn.":
      "linkedinClient's sentence's member form: the connection exists",
    "LinkedIn refused the post because the LinkedIn account you connected is not a Super admin of this company page. Ask a Super admin of the page to add that account as a Super admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.":
      "linkedinClient's sentence, matched by its words",
    "LinkedIn refused the post because the LinkedIn account you connected is not an admin of this company page. Ask a page admin to add that account as a Super admin or Content admin (Page admin tools > Manage admins), then reconnect LinkedIn in Settings.":
      "a superseded linkedinClient sentence old rows keep",
    "YouTube refused the upload, so nothing was posted: the upload permission wasn't granted when YouTube was connected. The workspace owner can reconnect YouTube and allow uploads; then retry.":
      "the missing-scope 403's member form: the connection exists",
    "YouTube refused the upload, so nothing was posted: the upload permission wasn't granted when YouTube was connected. Reconnect YouTube in Settings and allow uploads, then retry.":
      "the missing-scope 403: the connection exists",
    "${} didn't renew the connection. Try again later; if it keeps happening, the workspace owner can reconnect ${}.":
      "a refused renewal's member form: the connection exists",
    "${} didn't renew the connection. Try again later; if it keeps happening, reconnect ${} in Settings.":
      "a refused renewal: the connection exists",
    "The connected LinkedIn account is not a Super admin of any company page. The workspace owner can reconnect with an account that is a Super admin of one; then retry.":
      "linkedinClient's no-page help, member form: the connection exists",
    "The ${} connection ${}. The workspace owner can reconnect ${}; then retry.": "an expired connection's member form: it exists",
    "Pinterest did not renew this connection. If this keeps happening, the workspace owner can reconnect Pinterest.":
      "a refused Pinterest renewal's member form: the connection exists",
  },
  "server/notifications/postOutcomeEmail.ts": {},
  "server/jobs/failPendingResults.ts": {},
  "server/jobs/posting.ts": {},
  "server/jobs/inngest-functions.ts": {
    "This platform needs to be reconnected in Settings before publishing.":
      "publishToPlatform's flagged row: the connection exists, so always reconnect (wording kept for old and new rows)",
    "Reconnect required": "the step's own outcome for the run's log, never shown",
  },
  "app/api/posts/[postJobId]/publish/route.ts": {},
  "app/api/posts/[postJobId]/approval/route.ts": {},
  "app/api/posts/[postJobId]/pairRule.ts": {},
  "app/api/posts/[postJobId]/retry/route.ts": {},
  "components/activity/post-job-card.tsx": {
    "The workspace owner can connect ${}; then retry.": CARD_OWNER,
    "Connect ${} in Settings, then retry.": CARD_OWNER,
    "The workspace owner can reconnect ${}; then retry.": CARD_OWNER,
    "Reconnect ${} in Settings before retrying.": CARD_OWNER,
    Connect: CARD_OWNER,
    Reconnect: CARD_OWNER,
    "You're offline, so the retry of ${} wasn't sent. Reconnect, then retry again.":
      "the reader's own network, not a platform's connection",
  },
};

describe("connection steps on the publish path are worded by lib/connectionSteps.ts", () => {
  for (const [file, allowed] of Object.entries(PUBLISH_PATH)) {
    it(file, () => {
      const found = stepTexts(file, readFileSync(path.join(SRC, file), "utf8"));
      const worded = found.filter((text) => !(text in allowed));
      expect(worded, `${file} words a connect or reconnect step itself: use connectionStepSentence`).toEqual([]);
      const gone = Object.keys(allowed).filter((text) => !found.includes(text));
      expect(gone, `${file}: no longer holds these, so take them off the list`).toEqual([]);
    });
  }
});

describe("the guard itself", () => {
  it("fails on a planted Reconnect literal in a listed file", () => {
    const file = "app/api/posts/[postJobId]/publish/route.ts";
    const planted = `${readFileSync(path.join(SRC, file), "utf8")}\nexport const PLANTED = "Reconnect X in Settings, then retry.";\n`;
    const found = stepTexts(file, planted).filter((text) => !(text in PUBLISH_PATH[file]));
    expect(found).toEqual(["Reconnect X in Settings, then retry."]);
  });

  it("finds a step word handed in before the platform, then the retry", () => {
    const source = [
      "const a = `${capitalized(step)} ${label}, then retry.`;",
      "const b = `The workspace owner can ${verb} ${label}; then retry.`;",
      "const c = `${capitalized(step)} ${label}; then use Retry in Activity.`;",
      "const d = `${label} is ${state}, so it was not sent.`;",
    ].join("\n");
    expect(stepTexts("planted.ts", source)).toEqual([
      "${} ${}, then retry.",
      "The workspace owner can ${} ${}; then retry.",
      "${} ${}; then use Retry in Activity.",
    ]);
  });

  it("finds a step in a template and in JSX text, not in a comment, a code or a description", () => {
    const source = [
      "// Reconnect it in Settings.",
      "const a = `Connect ${label} in Settings, then retry.`;",
      'const b = step === "reconnect";',
      'const c = "X is no longer connected; it needs reconnecting.";',
      "const d = <p>Reconnect {label} in Settings</p>;",
    ].join("\n");
    expect(stepTexts("planted.tsx", source)).toEqual(["Connect ${} in Settings, then retry.", "Reconnect"]);
  });
});
