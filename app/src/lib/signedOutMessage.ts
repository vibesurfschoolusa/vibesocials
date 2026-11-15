/**
 * R20 new-customer L2: what a 401 for "no session" says, in a module with no
 * server imports so client code (lib/uploadFailure.ts) can use it too.
 */
export const SIGNED_OUT_ERROR = "You were signed out. Sign in again.";
