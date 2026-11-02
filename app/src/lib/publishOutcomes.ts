/**
 * The error a publish result carries when we cannot tell whether the platform
 * call went through (2026-11-01 scale audit, jobs H6).
 *
 * A platform step claims its result before it calls the platform. A claimed
 * result that never reached `success` or a platform error lost its run
 * mid-call: the post may be live. Marking it "failed, please retry" would
 * invite a second post, so it carries this code and message instead. The file
 * has no server-only imports, so any layer may use it; the Activity card
 * prefixes the platform label.
 */
export const PUBLISH_UNCONFIRMED_CODE = "PUBLISH_UNCONFIRMED";

export const PUBLISH_UNCONFIRMED_MESSAGE =
  "We couldn't confirm this post. It may already be live — check the platform before you retry.";
