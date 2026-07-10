"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, MessageSquare } from "lucide-react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ErrorState } from "@/components/reviews/error-state";
import { LocationPicker } from "@/components/reviews/location-picker";
import { ReviewCard } from "@/components/reviews/review-card";
import type { GoogleReview, Location } from "@/components/reviews/types";

// Toasts are provided app-wide by the shell's ToastProvider (see
// components/shell/app-shell.tsx), so this page no longer wraps its own.
export default function ReviewsPage() {
  return <ReviewsPageContent />;
}

function ReviewsPageContent() {
  const toast = useToast();

  const [reviews, setReviews] = useState<GoogleReview[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [reviewsError, setReviewsError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [generatingAI, setGeneratingAI] = useState<string | null>(null);

  const loadLocations = useCallback(async () => {
    try {
      setLoadingLocations(true);
      setLocationsError(null);
      const response = await fetch("/api/reviews/locations");

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch locations");
      }

      const data = await response.json();
      const locs: Location[] = data.locations || [];
      setLocations(locs);

      // Auto-select first location if only one exists
      if (locs.length === 1) {
        setSelectedLocation(locs[0].name);
      }
    } catch (err: unknown) {
      console.error("Error fetching locations:", err);
      setLocationsError((err as Error).message || "Failed to load locations");
    } finally {
      setLoadingLocations(false);
    }
  }, []);

  const loadReviews = useCallback(async () => {
    if (!selectedLocation) return;

    try {
      setLoading(true);
      setReviewsError(null);

      const response = await fetch(
        `/api/reviews?location=${encodeURIComponent(selectedLocation)}`
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to fetch reviews");
      }

      const data = await response.json();
      setReviews(data.reviews || []);
    } catch (err: unknown) {
      console.error("Error fetching reviews:", err);
      setReviewsError((err as Error).message || "Failed to load reviews");
    } finally {
      setLoading(false);
    }
  }, [selectedLocation]);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  useEffect(() => {
    loadReviews();
  }, [loadReviews]);

  // Validate then post the reply.
  const requestReply = (review: GoogleReview) => {
    const comment = replyText[review.reviewId]?.trim();

    if (!comment) {
      toast.error("Please enter a reply message");
      return;
    }

    performReply(review);
  };

  const performReply = async (review: GoogleReview) => {
    const comment = replyText[review.reviewId]?.trim();
    if (!comment) {
      return;
    }

    try {
      setSubmitting(review.reviewId);

      const response = await fetch(`/api/reviews/${review.reviewId}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment,
          reviewName: review.name, // Pass full review name for API
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to post reply");
      }

      // Update the review in the list
      setReviews((prevReviews) =>
        prevReviews.map((r) =>
          r.reviewId === review.reviewId
            ? {
                ...r,
                reviewReply: {
                  comment,
                  updateTime: new Date().toISOString(),
                },
              }
            : r
        )
      );

      // Clear reply text and close reply box
      setReplyText((prev) => ({ ...prev, [review.reviewId]: "" }));
      setReplyingTo(null);

      toast.success("Reply posted successfully!");
    } catch (err: unknown) {
      console.error("Error posting reply:", err);
      toast.error((err as Error).message || "Failed to post reply");
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
    } catch (err: unknown) {
      console.error("Error generating AI response:", err);
      toast.error((err as Error).message || "Failed to generate AI response");
    } finally {
      setGeneratingAI(null);
    }
  };

  const needsReplyReviews = reviews.filter((r) => !r.reviewReply);

  if (loadingLocations) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 lg:px-8">
        <div className="flex items-center justify-center py-20">
          <Spinner size="lg" label="Loading reviews" />
        </div>
      </div>
    );
  }

  if (locationsError) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 lg:px-8">
        <ErrorState
          title="Error Loading Reviews"
          message={locationsError}
          onRetry={loadLocations}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-8">
        <Link
          href="/"
          className="mb-4 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back to Dashboard
        </Link>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Google Reviews</h1>
        <p className="mt-2 text-muted-foreground">
          Manage and reply to your Google Business Profile reviews
        </p>
      </div>

      {/* Location Selector */}
      {locations.length > 1 && (
        <LocationPicker
          locations={locations}
          selectedLocation={selectedLocation}
          onChange={setSelectedLocation}
        />
      )}

      {/* Summary Card - Only Needs Reply */}
      {selectedLocation && !reviewsError && (
        <div className="mb-8">
          <Card className="max-w-sm p-6">
            <div className="text-sm font-medium text-muted-foreground">
              Reviews Needing Reply
            </div>
            <div className="mt-2 text-4xl font-bold text-warning">
              {needsReplyReviews.length}
            </div>
          </Card>
        </div>
      )}

      {/* Reviews List */}
      {!selectedLocation ? (
        <EmptyState
          icon={<MessageSquare />}
          title="Select a Location"
          description={
            locations.length === 0
              ? "No locations found. Please connect your Google Business Profile."
              : "Choose a location above to view and reply to reviews"
          }
        />
      ) : reviewsError ? (
        <ErrorState
          title="Error Loading Reviews"
          message={reviewsError}
          onRetry={loadReviews}
        />
      ) : loading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner size="lg" label="Loading reviews" />
        </div>
      ) : needsReplyReviews.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 border-success/30 bg-success/5 px-6 py-12 text-center">
          <div
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success"
          >
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-foreground">All Caught Up!</h3>
            <p className="mx-auto max-w-sm text-sm text-muted-foreground">
              No reviews need replies at this location. Great job!
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {needsReplyReviews.map((review) => (
            <ReviewCard
              key={review.reviewId}
              review={review}
              needsReply
              isReplyOpen={replyingTo === review.reviewId}
              isSubmitting={submitting === review.reviewId}
              isGeneratingAI={generatingAI === review.reviewId}
              replyValue={replyText[review.reviewId] || ""}
              onOpenReply={() => setReplyingTo(review.reviewId)}
              onCloseReply={() => setReplyingTo(null)}
              onChangeReply={(value) =>
                setReplyText((prev) => ({
                  ...prev,
                  [review.reviewId]: value,
                }))
              }
              onSubmitReply={() => requestReply(review)}
              onDraftAI={() => handleDraftAI(review)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
