"use client";

import Image from "next/image";
import { MessageSquare } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { nameInitial } from "@/lib/accountInitials";
import { cn } from "@/lib/cn";
import type { GoogleReview } from "./types";
import { StarRating } from "./star-rating";
import { DraftAIButton, ReplyForm, draftButtonId } from "./reply-form";
import { replyButtonId } from "./reviews-page";

function formatDate(dateString: string) {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The reviewer in a card button's name. R58 pages-b L2: every nameless
 * reviewer is "A Google user", so the name carries the date the card shows
 * too, and each review's buttons read differently.
 */
export function reviewButtonName(review: Pick<GoogleReview, "reviewer" | "createTime">): string {
  return `${review.reviewer.displayName}, ${formatDate(review.createTime)}`;
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
  /** Given while an AI draft's replaced text can be restored. */
  onUndoDraft?: () => void;
  /** JJ3 lead review: the in-place Google sign-in for this review's form, after a refused reply. */
  replySignInUrl?: string;
  /** R25 pages L4: why this review's last reply failed, for its form's status line. */
  replyRefusal?: string;
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
  onUndoDraft,
  replySignInUrl,
  replyRefusal,
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
            {nameInitial(review.reviewer.displayName)}
          </div>
        )}

        <div className="min-w-0 flex-1">
          {/* R24 pages L1: the row wraps on a 375 px phone, so the pill and the
              date move whole instead of breaking over two lines. */}
          <div className="flex flex-wrap items-start justify-between gap-2">
            {/* JJ3 second review: a one-word long name wraps at 375 px. */}
            <div className="min-w-0">
              <div className="break-words font-semibold text-foreground">
                {review.reviewer.displayName}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <StarRating rating={review.starRating} />
                <span className="whitespace-nowrap text-sm text-muted-foreground">
                  {formatDate(review.createTime)}
                </span>
              </div>
            </div>
            {needsReply && (
              <Badge variant="warning" className="shrink-0 whitespace-nowrap">
                Needs reply
              </Badge>
            )}
          </div>

          {/* Review Comment */}
          {review.comment && (
            <p className="mt-3 whitespace-pre-wrap break-words text-foreground">{review.comment}</p>
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
              <p className="whitespace-pre-wrap break-words text-sm text-foreground">
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
                  onUndoDraft={onUndoDraft}
                  signInUrl={replySignInUrl}
                  refusal={replyRefusal}
                  submitting={isSubmitting}
                  generatingAI={isGeneratingAI}
                />
              ) : (
                // R23 pages L2: wraps, so "Draft AI response" stays on a 375 px screen.
                <div className="flex flex-wrap gap-3">
                  <Button
                    id={replyButtonId(review.reviewId)}
                    type="button"
                    aria-label={`Reply to review by ${reviewButtonName(review)}`}
                    onClick={onOpenReply}
                  >
                    <MessageSquare aria-hidden className="h-4 w-4" />
                    Reply to review
                  </Button>
                  <DraftAIButton
                    id={draftButtonId(review.reviewId)}
                    drafting={isGeneratingAI}
                    onDraft={onDraftAI}
                    reviewer={reviewButtonName(review)}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
