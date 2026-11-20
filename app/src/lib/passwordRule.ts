/**
 * The rule for a new password, shared by register, reset-password and
 * change-password and by the forms that check before they send.
 *
 * R46 security L3: bcrypt reads only the first 72 UTF-8 bytes of a password
 * and ignores the rest without an error, so a longer one would be cut short
 * without a word, and a change made only past byte 72 would change nothing.
 * Sign-in does not use this rule, so a long password saved before it still
 * signs in.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_TOO_SHORT = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
export const PASSWORD_TOO_LONG = `Use a shorter password: at most ${PASSWORD_MAX_BYTES} bytes. Accented and non-Latin letters count as 2 to 3 bytes.`;

const encoder = new TextEncoder();

/** The sentence that refuses a new password, or null when it may be used. */
export function newPasswordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) return PASSWORD_TOO_SHORT;
  // A UTF-16 unit is at most 3 UTF-8 bytes, so a short string needs no encoding.
  if (password.length * 3 > PASSWORD_MAX_BYTES && encoder.encode(password).length > PASSWORD_MAX_BYTES) {
    return PASSWORD_TOO_LONG;
  }
  return null;
}

/** True when bcrypt would treat the two passwords as the same one. */
export function sameToBcrypt(a: string, b: string): boolean {
  const first = encoder.encode(a).subarray(0, PASSWORD_MAX_BYTES);
  const second = encoder.encode(b).subarray(0, PASSWORD_MAX_BYTES);
  return first.length === second.length && first.every((byte, index) => byte === second[index]);
}
