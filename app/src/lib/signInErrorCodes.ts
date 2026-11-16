// A plain module with no imports: auth.ts (server) throws these and Log in's
// helper (client) reads them back, and neither may pull in the other.

/**
 * R32 new-customer L1: authorize's failure codes. next-auth 4.24.15 answers a
 * thrown Error with a 401 whose url carries ?error=<its message>
 * (core/routes/callback.js), and signIn returns that as `error`
 * (react/index.js). So the message is a fixed code, never a database's text.
 */
/** A sign-in limit is used up. The buckets count every try for any address, so this says nothing about an account. */
export const SIGN_IN_LIMITED = "SignInLimited";
/** The password couldn't be checked (the database or the hash compare failed). */
export const SIGN_IN_UNCHECKED = "SignInUnchecked";
