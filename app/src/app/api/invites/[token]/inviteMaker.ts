/**
 * R9-client-journey L6: an invite link works only while the person who made it
 * is still an owner of its workspace. Demoting or leaving revokes their links
 * now, but links made before that (#151) were never revoked, so the preview
 * and Join both check the maker. A 404 like a dead link, so the join page
 * shows its invalid-link state.
 */
export const MAKER_NOT_OWNER_MESSAGE = "This invite link is no longer active. Ask an owner for a new one.";
