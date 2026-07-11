import Image from "next/image";
import { MessageSquare, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import type { GoogleReview } from "./types";
import { StarRating } from "./star-rating";
import { ReplyForm } from "./reply-form";

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface ReviewCardProps {
  review: GoogleReview;
  needsReply: boolean;
  isReplyOpen: boolean;
  isSubmitting: boolean;
  isGeneratingAI: boolean;
  replyValue: string;
  onOpenReply: () => void;
  onCloseReply: () => void;
  onChangeReply: (value: string) => void;
  onSubmitReply: () => void;
  onDraftAI: () => void;
}

/**
 * A single Google review with its reviewer info, comment, any existing reply,
 * and the reply/AI-draft actions when a reply is still needed.
 */
export function ReviewCard({
  review,
  needsReply,
  isReplyOpen,
  isSubmitting,
  isGeneratingAI,
  replyValue,
  onOpenReply,
  onCloseReply,
  onChangeReply,
  onSubmitReply,
  onDraftAI,
}: ReviewCardProps) {
  return (
    <Card className={cn("p-6", needsReply && "border-warning/30 bg-warning/5")}>
      {/* Reviewer Info */}
      <div className="flex items-start gap-4">
        {review.reviewer.profilePhotoUrl ? (
          <Image
            src={review.reviewer.profilePhotoUrl}
            alt={review.reviewer.displayName}
            width={48}
            height={48}
            unoptimized
            className="h-12 w-12 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary font-semibold text-primary-foreground">
            {review.reviewer.displayName[0]?.toUpperCase()}
          </div>
        )}

        <div className="flex-1">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold text-foreground">
                {review.reviewer.displayName}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <StarRating rating={review.starRating} />
                <span className="text-sm text-muted-foreground">
                  {formatDate(review.createTime)}
                </span>
              </div>
            </div>
            {needsReply && <Badge variant="warning">Needs reply</Badge>}
          </div>

          {/* Review Comment */}
          {review.comment && (
            <p className="mt-3 text-foreground">{review.comment}</p>
          )}

          {/* Existing Reply */}
          {review.reviewReply && (
            <div className="mt-4 rounded-[var(--radius)] border border-border bg-muted/40 p-4">
              <div className="mb-2 flex items-center gap-2">
                <MessageSquare aria-hidden className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium text-foreground">
                  Your reply
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDate(review.reviewReply.updateTime)}
                </span>
              </div>
              <p className="text-sm text-foreground">
                {review.reviewReply.comment}
              </p>
            </div>
          )}

          {/* Reply Form */}
          {!review.reviewReply && (
            <div className="mt-4">
              {isReplyOpen ? (
                <ReplyForm
                  value={replyValue}
                  onChange={onChangeReply}
                  onSubmit={onSubmitReply}
                  onCancel={onCloseReply}
                  onDraftAI={onDraftAI}
                  submitting={isSubmitting}
                  generatingAI={isGeneratingAI}
                />
              ) : (
                <div className="flex gap-3">
                  <Button type="button" onClick={onOpenReply}>
                    <MessageSquare aria-hidden className="h-4 w-4" />
                    Reply to review
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={onDraftAI}
                    loading={isGeneratingAI}
                  >
                    {!isGeneratingAI && <Sparkles aria-hidden className="h-4 w-4" />}
                    {isGeneratingAI ? "Generating…" : "Draft AI response"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
