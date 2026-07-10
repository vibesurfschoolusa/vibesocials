import Image from "next/image";
import { Loader2, MessageSquare, Star } from "lucide-react";
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
    <div
      className={`rounded-xl border ${
        needsReply
          ? "border-orange-200 bg-orange-50/50"
          : "border-gray-200 bg-white"
      } p-6 shadow-sm`}
    >
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
          <div className="h-12 w-12 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-semibold">
            {review.reviewer.displayName[0]?.toUpperCase()}
          </div>
        )}

        <div className="flex-1">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold text-gray-900">
                {review.reviewer.displayName}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <StarRating rating={review.starRating} />
                <span className="text-sm text-gray-500">
                  {formatDate(review.createTime)}
                </span>
              </div>
            </div>
            {needsReply && (
              <span className="px-3 py-1 rounded-full bg-orange-100 text-orange-700 text-xs font-medium">
                Needs Reply
              </span>
            )}
          </div>

          {/* Review Comment */}
          {review.comment && (
            <p className="mt-3 text-gray-700">{review.comment}</p>
          )}

          {/* Existing Reply */}
          {review.reviewReply && (
            <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-center gap-2 mb-2">
                <MessageSquare className="h-4 w-4 text-blue-600" />
                <span className="text-sm font-medium text-gray-900">
                  Your Reply
                </span>
                <span className="text-xs text-gray-500">
                  {formatDate(review.reviewReply.updateTime)}
                </span>
              </div>
              <p className="text-sm text-gray-700">
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
                  <button
                    type="button"
                    onClick={onOpenReply}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
                  >
                    <MessageSquare className="h-4 w-4" />
                    Reply to Review
                  </button>
                  <button
                    type="button"
                    onClick={onDraftAI}
                    disabled={isGeneratingAI}
                    className="inline-flex items-center gap-2 rounded-lg border-2 border-purple-200 px-4 py-2 text-sm font-semibold text-purple-700 hover:bg-purple-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isGeneratingAI ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Star className="h-4 w-4 fill-purple-600" />
                        Draft AI Response
                      </>
                    )}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
