// A plain module with no imports: auth.ts (server) throws these and Log in's
// helper (client) reads them back, and neither may pull in the other.

/**
 * R32 new-customer L1: authorize's failure codes. next-auth 4.24.15 answers a
 * thrown Error with a 401 whose url carries ?error=<its message>
 * (core/routes/callback.js), and signIn returns that as `error`
 * (react/index.js). So the message is a fixed code, never a database's text.
 */
/**
 * A sign-in limit is used up. The buckets count every try for any address, so
 * this says nothing about an account. Sent as "SignInLimited-<minutes>" when
 * the limiter gives its reset time (R32 lead: the sentence states a true wait).
 */
export const SIGN_IN_LIMITED = "SignInLimited";
/** The password couldn't be checked (the database or the hash compare failed). */
export const SIGN_IN_UNCHECKED = "SignInUnchecked";

/** The limit code with the limiter's wait in whole minutes (rounded up), or the bare code without one. */
export function signInLimitedCode(retryAfterSeconds: number | undefined): string {
  if (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return SIGN_IN_LIMITED;
  }
  return `${SIGN_IN_LIMITED}-${Math.max(1, Math.ceil(retryAfterSeconds / 60))}`;
}

/** For a limit code: its wait in minutes, or null when it carries none. undefined for any other error. */
export function signInLimitedWait(error: unknown): number | null | undefined {
  if (error === SIGN_IN_LIMITED) return null;
  if (typeof error !== "string") return undefined;
  const match = /^SignInLimited-([1-9]\d{0,3})$/.exec(error);
  return match ? Number(match[1]) : undefined;
}
