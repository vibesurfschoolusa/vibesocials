import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names and resolve conflicting Tailwind utilities.
 *
 * `clsx` flattens conditional/array/object class inputs into a string, then
 * `tailwind-merge` de-dupes conflicting utilities so the last one wins
 * (e.g. `cn("px-2", "px-4")` => `"px-4"`).
 *
 * This is the single class-composition helper for the design system; every
 * primitive uses it so callers can override any class via a `className` prop.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
