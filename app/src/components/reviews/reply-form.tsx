import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REPLY_TOO_LONG_MESSAGE, replyCounter, replyTooLong } from "@/lib/reviewReplyLength";

interface ReplyFormProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onDraftAI: () => void;
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
  submitting,
  generatingAI,
}: ReplyFormProps) {
  // R17 L1: Google takes at most 4096 bytes; an AI draft can be longer.
  const counter = replyCounter(value);
  const tooLong = replyTooLong(value);
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
        aria-describedby={counter ? "review-reply-length" : undefined}
      />
      {counter ? (
        <div id="review-reply-length" className={tooLong ? "space-y-1 text-xs text-destructive" : "text-xs text-muted-foreground"}>
          <p>{counter}</p>
          {tooLong ? <p>{REPLY_TOO_LONG_MESSAGE}</p> : null}
        </div>
      ) : null}
      <div className="flex gap-3">
        <Button type="button" onClick={onSubmit} loading={submitting} disabled={tooLong}>
          {submitting ? "Posting…" : "Post reply"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
