import type { ReactNode } from "react";

/**
 * The batch card's settings (platforms, Google, Feed or Story, YouTube,
 * location, when). Disabled while rows are sending, so nothing that applies to
 * every row changes halfway: a disabled fieldset disables every control inside
 * it natively, the shared components' own controls included.
 */
export function BatchSettingsFieldset({ locked, children }: { locked: boolean; children?: ReactNode }) {
  return (
    <fieldset data-bulk-batch-settings="" disabled={locked} className="m-0 flex min-w-0 flex-col gap-4 border-0 p-0">
      {children}
    </fieldset>
  );
}
