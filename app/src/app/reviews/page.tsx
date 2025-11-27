"use client";

import { useEffect, useState } from "react";
import { Star, MessageSquare, AlertCircle, Loader2, ArrowLeft } from "lucide-react";
import Link from "next/link";

interface GoogleReview {
  name: string;
  reviewId: string;
  reviewer: {
    profilePhotoUrl?: string;
    displayName: string;
    isAnonymous: boolean;
  };
  starRating: "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE";
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: {
    comment: string;
    updateTime: string;
  };
}

const STAR_RATINGS = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export default function ReviewsPage() {
  const [reviews, setReviews] = useState<GoogleReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [generatingAI, setGeneratingAI] = useState<string | null>(null);

  useEffect(() => {
    fetchReviews();
  }, []);

  const fetchReviews = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch("/api/reviews");

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch reviews");
      }

      const data = await response.json();
      setReviews(data.reviews || []);
    } catch (err: any) {
      console.error("Error fetching reviews:", err);
      setError(err.message || "Failed to load reviews");
    } finally {
      setLoading(false);
    }
  };

  const handleReply = async (reviewId: string) => {
    const comment = replyText[reviewId]?.trim();

    if (!comment) {
      alert("Please enter a reply message");
      return;
    }

    try {
      setSubmitting(reviewId);

      const response = await fetch(`/api/reviews/${reviewId}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ comment }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to post reply");
      }

      // Update the review in the list
      setReviews((prevReviews) =>
        prevReviews.map((review) =>
          review.reviewId === reviewId
            ? {
                ...review,
                reviewReply: {
                  comment,
                  updateTime: new Date().toISOString(),
                },
              }
            : review
        )
      );

      // Clear reply text and close reply box
      setReplyText((prev) => ({ ...prev, [reviewId]: "" }));
      setReplyingTo(null);

      alert("Reply posted successfully!");
    } catch (err: any) {
      console.error("Error posting reply:", err);
      alert(err.message || "Failed to post reply");
    } finally {
      setSubmitting(null);
    }
  };

  const handleDraftAI = async (review: GoogleReview) => {
    try {
      setGeneratingAI(review.reviewId);

      const response = await fetch("/api/reviews/draft-response", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reviewerName: review.reviewer.displayName,
          starRating: review.starRating,
          comment: review.comment || "",
          businessName: "", // Can be configured later
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to generate AI response");
      }

      const data = await response.json();
      const draftResponse = data.draftResponse;

      // Populate the reply text box with AI-generated response
      setReplyText((prev) => ({
        ...prev,
        [review.reviewId]: draftResponse,
      }));

      // Open the reply box if not already open
      if (replyingTo !== review.reviewId) {
        setReplyingTo(review.reviewId);
      }
    } catch (err: any) {
      console.error("Error generating AI response:", err);
      alert(err.message || "Failed to generate AI response");
    } finally {
      setGeneratingAI(null);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const renderStars = (rating: keyof typeof STAR_RATINGS) => {
    const numStars = STAR_RATINGS[rating];
    return (
      <div className="flex gap-0.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Star
            key={i}
            className={`h-4 w-4 ${
              i < numStars
                ? "fill-yellow-400 text-yellow-400"
                : "fill-gray-200 text-gray-200"
            }`}
          />
        ))}
      </div>
    );
  };

  const needsReply = reviews.filter((r) => !r.reviewReply);
  const hasReplies = reviews.filter((r) => r.reviewReply);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
        <div className="container mx-auto max-w-6xl px-4 py-8">
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
        <div className="container mx-auto max-w-6xl px-4 py-8">
          <div className="rounded-lg border border-red-200 bg-red-50 p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-red-900">Error Loading Reviews</h3>
                <p className="mt-1 text-sm text-red-700">{error}</p>
                {error.includes("not configured") && (
                  <Link
                    href="/connections"
                    className="mt-3 inline-block text-sm text-blue-600 hover:text-blue-700 underline"
                  >
                    Go to Connections →
                  </Link>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <div className="container mx-auto max-w-6xl px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 mb-4 transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Dashboard
          </Link>
          <h1 className="text-3xl font-bold text-gray-900">Google Reviews</h1>
          <p className="mt-2 text-gray-600">
            Manage and reply to your Google Business Profile reviews
          </p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="text-sm font-medium text-gray-600">Total Reviews</div>
            <div className="mt-2 text-3xl font-bold text-gray-900">
              {reviews.length}
            </div>
          </div>
          <div className="rounded-xl border border-orange-200 bg-orange-50 p-6 shadow-sm">
            <div className="text-sm font-medium text-orange-900">Need Reply</div>
            <div className="mt-2 text-3xl font-bold text-orange-600">
              {needsReply.length}
            </div>
          </div>
          <div className="rounded-xl border border-green-200 bg-green-50 p-6 shadow-sm">
            <div className="text-sm font-medium text-green-900">Replied</div>
            <div className="mt-2 text-3xl font-bold text-green-600">
              {hasReplies.length}
            </div>
          </div>
        </div>

        {/* Reviews List */}
        {reviews.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white p-12 text-center">
            <MessageSquare className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-semibold text-gray-900">No Reviews Yet</h3>
            <p className="mt-2 text-gray-600">
              Your Google Business Profile reviews will appear here
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Reviews Needing Reply */}
            {needsReply.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  Needs Reply ({needsReply.length})
                </h2>
                <div className="space-y-4">
                  {needsReply.map((review) => (
                    <ReviewCard
                      key={review.reviewId}
                      review={review}
                      replyingTo={replyingTo}
                      setReplyingTo={setReplyingTo}
                      replyText={replyText}
                      setReplyText={setReplyText}
                      submitting={submitting}
                      handleReply={handleReply}
                      handleDraftAI={handleDraftAI}
                      generatingAI={generatingAI}
                      renderStars={renderStars}
                      formatDate={formatDate}
                      needsReply={true}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Reviews With Replies */}
            {hasReplies.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  Replied ({hasReplies.length})
                </h2>
                <div className="space-y-4">
                  {hasReplies.map((review) => (
                    <ReviewCard
                      key={review.reviewId}
                      review={review}
                      replyingTo={replyingTo}
                      setReplyingTo={setReplyingTo}
                      replyText={replyText}
                      setReplyText={setReplyText}
                      submitting={submitting}
                      handleReply={handleReply}
                      handleDraftAI={handleDraftAI}
                      generatingAI={generatingAI}
                      renderStars={renderStars}
                      formatDate={formatDate}
                      needsReply={false}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ReviewCardProps {
  review: GoogleReview;
  replyingTo: string | null;
  setReplyingTo: (id: string | null) => void;
  replyText: Record<string, string>;
  setReplyText: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  submitting: string | null;
  handleReply: (reviewId: string) => void;
  handleDraftAI: (review: GoogleReview) => void;
  generatingAI: string | null;
  renderStars: (rating: keyof typeof STAR_RATINGS) => React.JSX.Element;
  formatDate: (date: string) => string;
  needsReply: boolean;
}

function ReviewCard({
  review,
  replyingTo,
  setReplyingTo,
  replyText,
  setReplyText,
  submitting,
  handleReply,
  handleDraftAI,
  generatingAI,
  renderStars,
  formatDate,
  needsReply,
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
          <img
            src={review.reviewer.profilePhotoUrl}
            alt={review.reviewer.displayName}
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
                {renderStars(review.starRating)}
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
                <span className="text-sm font-medium text-gray-900">Your Reply</span>
                <span className="text-xs text-gray-500">
                  {formatDate(review.reviewReply.updateTime)}
                </span>
              </div>
              <p className="text-sm text-gray-700">{review.reviewReply.comment}</p>
            </div>
          )}

          {/* Reply Form */}
          {!review.reviewReply && (
            <div className="mt-4">
              {replyingTo === review.reviewId ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-gray-700">Your Reply</label>
                    <button
                      onClick={() => handleDraftAI(review)}
                      disabled={generatingAI === review.reviewId}
                      className="inline-flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {generatingAI === review.reviewId ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          <Star className="h-3 w-3 fill-purple-600" />
                          Draft AI Response
                        </>
                      )}
                    </button>
                  </div>
                  <textarea
                    value={replyText[review.reviewId] || ""}
                    onChange={(e) =>
                      setReplyText((prev) => ({
                        ...prev,
                        [review.reviewId]: e.target.value,
                      }))
                    }
                    placeholder="Write your reply or use AI to draft one..."
                    rows={4}
                    className="w-full rounded-lg border border-gray-300 px-4 py-2 text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 outline-none resize-none"
                  />
                  <div className="flex gap-3">
                    <button
                      onClick={() => handleReply(review.reviewId)}
                      disabled={submitting === review.reviewId}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {submitting === review.reviewId ? (
                        <span className="flex items-center gap-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Posting...
                        </span>
                      ) : (
                        "Post Reply"
                      )}
                    </button>
                    <button
                      onClick={() => setReplyingTo(null)}
                      disabled={submitting === review.reviewId}
                      className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-3">
                  <button
                    onClick={() => setReplyingTo(review.reviewId)}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
                  >
                    <MessageSquare className="h-4 w-4" />
                    Reply to Review
                  </button>
                  <button
                    onClick={() => handleDraftAI(review)}
                    disabled={generatingAI === review.reviewId}
                    className="inline-flex items-center gap-2 rounded-lg border-2 border-purple-200 px-4 py-2 text-sm font-semibold text-purple-700 hover:bg-purple-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {generatingAI === review.reviewId ? (
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
