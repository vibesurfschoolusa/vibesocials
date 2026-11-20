/**
 * The one rule for a file name's extension (R47 client-journey L2, lead
 * review): 1-5 letters or digits after the last dot, with at least one letter.
 * So the dot in "Surf day 19.11.2026", "Session at 10.30" or "St. Lucia sunset"
 * starts none. Used to judge a typeless file and to rename or cut a name.
 */
const EXTENSION = /\.((?=[a-z0-9]*[a-z])[a-z0-9]{1,5})$/i;

/** The name's extension, lower case; undefined when it has none. */
export function extensionOf(name: string): string | undefined {
  return EXTENSION.exec(name)?.[1].toLowerCase();
}

/** The name without its extension (with the dot); the whole name when it has none. */
export function withoutExtension(name: string): string {
  return name.replace(EXTENSION, "");
}
