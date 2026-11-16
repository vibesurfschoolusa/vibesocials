import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REPLY_TOO_LONG_MESSAGE, replyCounter, replyTooLong } from "@/lib/reviewReplyLength";

const DRAFTING_STATUS = "Writing a draft. You can edit it here as soon as it is ready.";
const UNDO_STATUS = "Draft written. Undo to get your text back.";
export const RESTORED_STATUS = "Your text is back.";

/**
 * The second status line (R24 pages L2): Undo while it is offered; after an
 * Undo (its button gone), that the text is back, so the change is announced.
 */
export function replyUndoStatus(canUndo: boolean, restored: boolean): string {
  if (canUndo) return UNDO_STATUS;
  return restored ? RESTORED_STATUS : "";
}

/** Where keyboard focus is, seen from one reply form. */
export type FocusPlace = "this form" | "body" | "elsewhere";

/**
 * Whether the box takes focus now (R24 pages L2): only once a draft asked for
 * with this form's own Draft button is no longer being written, and only while
 * focus is still in this form or was dropped to the page body (the Draft
 * button is disabled while it writes). Focus the person moved elsewhere, say to
 * another card's Draft button, stays there. A draft started from the card, or
 * another review's, leaves focus where it is.
 */
export function focusBoxAfterDraft(drafting: boolean, draftedHere: boolean, focusAt: FocusPlace): boolean {
  return draftedHere && !drafting && focusAt !== "elsewhere";
}

/** `active` is document.activeElement; null or the body itself means focus was dropped. */
export function focusPlace<N>(active: N | null, form: { contains(node: N): boolean } | null, body: N | null): FocusPlace {
  if (!active || active === body) return "body";
  if (form?.contains(active)) return "this form";
  return "elsewhere";
}

/** The effect run when `drafting` changes: the mark is used once the draft ends. */
export function settleDraftFocus(args: {
  drafting: boolean;
  draftedHere: { current: boolean };
  where: () => FocusPlace;
  focusBox: () => void;
}): void {
  if (args.drafting || !args.draftedHere.current) return;
  const focus = focusBoxAfterDraft(args.drafting, args.draftedHere.current, args.where());
  args.draftedHere.current = false;
  if (focus) args.focusBox();
}

/** This form's Draft button: marks the draft as asked for here. */
export function startDraftHere(args: {
  draftedHere: { current: boolean };
  setRestored: (restored: boolean) => void;
  onDraftAI: () => void;
}): void {
  args.draftedHere.current = true;
  args.setRestored(false);
  args.onDraftAI();
}

/** Undo: its button leaves with this click, so focus goes to the restored text. */
export function undoReply(args: {
  onUndoDraft?: () => void;
  setRestored: (restored: boolean) => void;
  focusBox: () => void;
}): void {
  args.onUndoDraft?.();
  args.setRestored(true);
  args.focusBox();
}

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

/**
 * The review whose box is open once `drafted`'s draft lands: its own when no box
 * is open; otherwise the open one stays, with its text and focus, and the draft
 * (with its Undo) waits in its own box until that review is opened again.
 */
export function openAfterDraft(open: string | null, drafted: string): string | null {
  return open ?? drafted;
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
  const formRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // Set when this form's Draft button is pressed; read when that draft ends.
  const draftedHere = useRef(false);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    settleDraftFocus({
      drafting: generatingAI,
      draftedHere,
      where: () => focusPlace(document.activeElement, formRef.current, document.body),
      focusBox: () => boxRef.current?.focus(),
    });
  }, [generatingAI]);

  const draftHere = () => startDraftHere({ draftedHere, setRestored, onDraftAI });
  const undo = () => undoReply({ onUndoDraft, setRestored, focusBox: () => boxRef.current?.focus() });
  return (
    <div ref={formRef} className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="review-reply">Your reply</Label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={draftHere}
          loading={generatingAI}
        >
          {!generatingAI && <Sparkles aria-hidden className="h-3.5 w-3.5" />}
          {generatingAI ? "Generating…" : "Draft AI response"}
        </Button>
      </div>
      <Textarea
        ref={boxRef}
        id="review-reply"
        value={value}
        onChange={(e) => {
          setRestored(false);
          onChange(e.target.value);
        }}
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
          {replyUndoStatus(canUndo, restored)}
        </p>
        {canUndo ? (
          <Button type="button" variant="outline" size="sm" onClick={undo} disabled={submitting}>
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
