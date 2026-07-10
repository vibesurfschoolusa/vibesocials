import { Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
 * The expanded reply editor: a textarea plus "Draft AI Response", "Post Reply"
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
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label htmlFor="review-reply">Your Reply</Label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onDraftAI}
          loading={generatingAI}
        >
          {!generatingAI && <Star aria-hidden className="h-3.5 w-3.5" />}
          {generatingAI ? "Generating..." : "Draft AI Response"}
        </Button>
      </div>
      <Textarea
        id="review-reply"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write your reply or use AI to draft one..."
        rows={4}
        className="resize-none"
      />
      <div className="flex gap-3">
        <Button type="button" onClick={onSubmit} loading={submitting}>
          {submitting ? "Posting..." : "Post Reply"}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
