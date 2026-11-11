/**
 * The workspace's report logo (18b): the limits and the sentences shared by
 * POST/DELETE /api/workspaces/logo and the Settings control. The server half
 * (reading the body, decoding and re-encoding) is src/server/workspaceLogo.ts.
 */

/** Largest upload accepted, in bytes (1 MB). */
export const LOGO_MAX_BYTES = 1024 * 1024;
/** The stored PNG fits inside this box; a smaller picture is never enlarged. */
export const LOGO_MAX_WIDTH = 600;
export const LOGO_MAX_HEIGHT = 300;
/** Uploads and removals an owner may make per hour. */
export const LOGO_CHANGES_PER_HOUR = 10;

export const LOGO_HELP_LINE = "PNG or JPEG, up to 1 MB. It appears on your monthly report.";

export const LOGO_TOO_LARGE_MESSAGE = "That file is over 1 MB. Choose a smaller PNG or JPEG.";
export const LOGO_EMPTY_MESSAGE = "No file arrived. Choose a PNG or JPEG and try again.";
export const LOGO_NOT_IMAGE_MESSAGE =
  "That file isn't a picture we can read. Choose a PNG or JPEG, up to 1 MB.";
export const LOGO_SVG_MESSAGE = "SVG files can't be used as a logo. Choose a PNG or JPEG, up to 1 MB.";
export const LOGO_LIMIT_MESSAGE = "You've changed the logo 10 times in the last hour. Try again later.";
export const LOGO_SAVE_FAILED_MESSAGE = "Couldn't save the logo. Nothing was changed. Try again.";
export const LOGO_REMOVE_FAILED_MESSAGE = "Couldn't remove the logo. Nothing was changed. Try again.";
