/**
 * What the limits form sends (fix round 1, 2026-11-10): only the fields the
 * operator edited. Sending all four with the values from page load would undo
 * a change another operator saved to a different limit in the meantime. An
 * emptied field is null ("use the default"); an empty change is refused.
 */

export type LimitInput = { field: string; label: string; initial: number | null; max: number };

export function limitsChangeBody(
  fields: LimitInput[],
  values: Record<string, string>,
): { ok: true; body: Record<string, number | null> } | { ok: false; error: string } {
  const body: Record<string, number | null> = {};
  for (const f of fields) {
    const raw = (values[f.field] ?? "").trim();
    let next: number | null = null;
    if (raw !== "") {
      next = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(next) || next > f.max) {
        return {
          ok: false,
          error: `${f.label}: enter a whole number from 0 to ${f.max.toLocaleString("en-US")}, or leave it empty for the default.`,
        };
      }
    }
    if (next !== f.initial) body[f.field] = next;
  }
  if (Object.keys(body).length === 0) return { ok: false, error: "Nothing changed." };
  return { ok: true, body };
}
