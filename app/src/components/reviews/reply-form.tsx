import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REPLY_TOO_LONG_MESSAGE, replyCounter, replyTooLong } from "@/lib/reviewReplyLength";

const DRAFTING_STATUS = "Writing a draft. You can edit it here as soon as it is ready.";
const UNDO_STATUS = "Draft written. Undo to get your text back.";

/**
 * The reply boxes of the Reviews page, by review id: the text, and the person's
 * own text an AI draft replaced (R23 client-journey L3, lead follow-up). Undo
 * brings it back until they type again or post.
 */
export interface ReplyBoxes {
  text: Record<string, string>;
  undo: Record<string, string>;
}

export const EMPTY_REPLY_BOXES: ReplyBoxes = { text: {}, undo: {} };

function withoutUndo(undo: Record<string, string>, id: string): Record<string, string> {
  if (!(id in undo)) return undo;
  const rest = { ...undo };
  delete rest[id];
  return rest;
}

export function replyBoxAfterTyping(boxes: ReplyBoxes, id: string, value: string): ReplyBoxes {
  return { text: { ...boxes.text, [id]: value }, undo: withoutUndo(boxes.undo, id) };
}

/**
 * The draft fills the box. Text the person wrote is kept for Undo; when the box
 * holds an earlier, untouched draft, the person's own text kept then stays.
 */
export function replyBoxAfterDraft(boxes: ReplyBoxes, id: string, draft: string): ReplyBoxes {
  const previous = boxes.text[id] ?? "";
  const kept = boxes.undo[id] ?? (previous.trim() ? previous : undefined);
  return {
    text: { ...boxes.text, [id]: draft },
    undo: kept === undefined ? withoutUndo(boxes.undo, id) : { ...boxes.undo, [id]: kept },
  };
}

export function replyBoxAfterUndo(boxes: ReplyBoxes, id: string): ReplyBoxes {
  const kept = boxes.undo[id];
  if (kept === undefined) return boxes;
  return { text: { ...boxes.text, [id]: kept }, undo: withoutUndo(boxes.undo, id) };
}

/** The reviews whose AI draft is being written: each box stays locked until its own lands or fails. */
export function draftingAfterStart(drafting: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set(drafting).add(id);
}

export function draftingAfterEnd(drafting: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const rest = new Set(drafting);
  rest.delete(id);
  return rest;
}

export function replyBoxAfterPost(boxes: ReplyBoxes, id: string): ReplyBoxes {
  return { text: { ...boxes.text, [id]: "" }, undo: withoutUndo(boxes.undo, id) };
}

interface ReplyFormProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDraftAI: () => void;
  /** Given while a draft's replaced text can be restored. */
  onUndoDraft?: () => void;
  submitting: boolean;
  generatingAI: boolean;
}

/**
 * The expanded reply editor: a textarea plus "Draft AI response", "Post reply"
 * and "Cancel" actions.
 */
export function ReplyForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  onDraftAI,
  onUndoDraft,
  submitting,
  generatingAI,
}: ReplyFormProps) {
  // R17 L1: Google takes at most 4096 bytes; an AI draft can be longer.
  const counter = replyCounter(value);
  const tooLong = replyTooLong(value);
  const describedBy = [generatingAI ? "review-reply-drafting" : "", counter ? "review-reply-length" : ""]
    .filter(Boolean)
    .join(" ");
  const canUndo = onUndoDraft !== undefined && !generatingAI;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="review-reply">Your reply</Label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onDraftAI}
          loading={generatingAI}
        >
          {!generatingAI && <Sparkles aria-hidden className="h-3.5 w-3.5" />}
          {generatingAI ? "Generating…" : "Draft AI response"}
        </Button>
      </div>
      <Textarea
        id="review-reply"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write your reply or use AI to draft one..."
        rows={4}
        className="resize-none"
        aria-invalid={tooLong || undefined}
        aria-describedby={describedBy || undefined}
        // R23 client-journey L3: the draft fills the box when it arrives, so the
        // box takes no typing meanwhile (read-only keeps focus) and says why.
        readOnly={generatingAI}
        aria-busy={generatingAI || undefined}
      />
      {/* Both live regions stay on the page and only their text changes, so
          screen readers announce it (a region added with its text is often missed).
          Empty, they are sr-only: still in the tree, taking no space. */}
      <p id="review-reply-drafting" role="status" className="text-xs text-muted-foreground empty:sr-only">
        {generatingAI ? DRAFTING_STATUS : ""}
      </p>
      <div className={canUndo ? "flex flex-wrap items-center gap-3" : "contents"}>
        <p role="status" className="text-xs text-muted-foreground empty:sr-only">
          {canUndo ? UNDO_STATUS : ""}
        </p>
        {canUndo ? (
          <Button type="button" variant="outline" size="sm" onClick={onUndoDraft} disabled={submitting}>
            Undo
          </Button>
        ) : null}
      </div>
      {counter ? (
        <div id="review-reply-length" className={tooLong ? "space-y-1 text-xs text-destructive" : "text-xs text-muted-foreground"}>
          <p>{counter}</p>
          {tooLong ? <p>{REPLY_TOO_LONG_MESSAGE}</p> : null}
        </div>
      ) : null}
      <div className="flex gap-3">
        <Button type="button" onClick={onSubmit} loading={submitting} disabled={tooLong || generatingAI}>
          {submitting ? "Posting…" : "Post reply"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
