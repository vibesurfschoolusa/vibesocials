import { captionCounter, captionTooLongMessage } from "@/lib/captionLimits";
import { cn } from "@/lib/cn";

/**
 * 2026-11-01 scale audit (jobs, event size): the live "1,234 / 10,000" counter under a
 * caption textarea. Muted until the text passes the cap, then destructive with
 * the inline "Caption is too long" message. Presentation only - the counting
 * and the cap live in lib/captionLimits.ts, and each form's submit guard calls
 * `captionCounter(text).over` itself. The textarea gets no `maxLength`: it
 * would silently truncate a paste.
 */
export function CaptionCounter({
  text,
  id,
  className,
}: {
  text: string;
  /** Put on the count so the textarea can point `aria-describedby` at it. */
  id?: string;
  className?: string;
}) {
  const counter = captionCounter(text);
  return (
    <div className={cn("flex items-start justify-between gap-2 text-xs", className)}>
      {counter.over ? (
        <p role="alert" className="text-destructive">
          {captionTooLongMessage("Caption")}
        </p>
      ) : null}
      <p
        id={id}
        className={cn(
          "ml-auto tabular-nums",
          counter.over ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {counter.label}
      </p>
    </div>
  );
}
