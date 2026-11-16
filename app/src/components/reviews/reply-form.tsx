import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SignInAgainLink } from "@/components/gbp-sign-in-link";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { gbpSignInUrl } from "@/lib/gbpSignIn";
import type { ShownError } from "./api-error";
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
export type FocusPlace = "this form" | "elsewhere";

/**
 * Whether the box takes focus now (R24 pages L2): only once a draft asked for
 * with this form's own Draft button is no longer being written, and only while
 * focus is still in this form (on that button, which stays focusable while it
 * writes: DraftAIButton). Focus anywhere else, say on another card's Draft
 * button, stays there. A draft started from the card, or another review's,
 * leaves focus where it is.
 */
export function focusBoxAfterDraft(drafting: boolean, draftedHere: boolean, focusAt: FocusPlace): boolean {
  return draftedHere && !drafting && focusAt === "this form";
}

/**
 * `active` is document.activeElement. JJ3 second review: nothing focused, or
 * the body, is not this form's: no Draft button drops focus any more, so a
 * body focus says nothing about whose button it was.
 */
export function focusPlace<N>(active: N | null, form: { contains(node: N): boolean } | null): FocusPlace {
  return active && form?.contains(active) ? "this form" : "elsewhere";
}

/**
 * JJ3 lead review: the review whose reply failed because Google wants the
 * owner to sign in again (the route's `signIn`), or null. Its form shows the
 * in-place sign-in link; a member's page never gets one, and any other failure
 * of that review clears it.
 */
export function replySignInAfterFailure(
  current: string | null,
  reviewId: string,
  shown: ShownError,
  isMember: boolean,
): string | null {
  if (shown.signIn && !isMember) return reviewId;
  return current === reviewId ? null : current;
}

/** Typing, sending again or closing that review's form clears its link. */
export function replySignInCleared(current: string | null, reviewId: string): string | null {
  return current === reviewId ? null : current;
}

/** The link for a review's form, from the page's own workspace (lib/gbpSignIn.ts), else undefined. */
export function replySignInHref(current: string | null, reviewId: string, workspaceId: string): string | undefined {
  return current === reviewId ? gbpSignInUrl(workspaceId) : undefined;
}

/** The card's Draft button, by review id: the page checks focus against it as a draft lands. */
export function draftButtonId(reviewId: string): string {
  return `review-draft-${reviewId}`;
}

/**
 * JJ3 lead review: a draft from the card's Draft button opens the form, and the
 * button leaves with it. The new box takes focus only when, as the draft
 * landed, focus was on that very button (the person's own action) and the box
 * that opened is that review's; anywhere else, focus is left alone.
 */
export function focusBoxAfterCardDraft(
  activeIdAtLanding: string | null | undefined,
  reviewId: string,
  openReview: string | null,
): boolean {
  return activeIdAtLanding === draftButtonId(reviewId) && openReview === reviewId;
}

/** A Draft press while its draft is being written is ignored (the button stays focusable). */
export function draftClick(drafting: boolean, onDraft: () => void): () => void {
  return () => {
    if (!drafting) onDraft();
  };
}

/**
 * "Draft AI response", on the card and in the form. JJ3 second review: while
 * it writes it is aria-disabled and aria-busy, never `disabled`, so keyboard
 * focus stays on it instead of dropping to the page body (Button's `loading`
 * disables, so it is not used here).
 */
export function DraftAIButton({
  drafting,
  onDraft,
  size = "md",
  id,
}: {
  drafting: boolean;
  onDraft: () => void;
  size?: "sm" | "md";
  id?: string;
}) {
  const icon = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <Button
      id={id}
      type="button"
      variant="secondary"
      size={size}
      onClick={draftClick(drafting, onDraft)}
      aria-disabled={drafting || undefined}
      aria-busy={drafting || undefined}
      className={drafting ? "cursor-progress opacity-50" : undefined}
    >
      {drafting ? <Spinner size="sm" /> : <Sparkles aria-hidden className={icon} />}
      {drafting ? "Generating…" : "Draft AI response"}
    </Button>
  );
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
  /** JJ3 lead review: the in-place Google sign-in, after a reply Google refused (replySignInHref). */
  signInUrl?: string;
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
  signInUrl,
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
      where: () => focusPlace(document.activeElement, formRef.current),
      focusBox: () => boxRef.current?.focus(),
    });
  }, [generatingAI]);

  const draftHere = () => startDraftHere({ draftedHere, setRestored, onDraftAI });
  const undo = () => undoReply({ onUndoDraft, setRestored, focusBox: () => boxRef.current?.focus() });
  return (
    <div ref={formRef} className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="review-reply">Your reply</Label>
        <DraftAIButton drafting={generatingAI} onDraft={draftHere} size="sm" />
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
      {/* A live region that stays on the page, so the link is announced when it appears. */}
      <div role="status" className="empty:sr-only">
        {signInUrl ? <SignInAgainLink href={signInUrl} /> : null}
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
