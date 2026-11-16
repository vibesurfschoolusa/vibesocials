"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, MessageSquare } from "lucide-react";

import { SignInAgainLink } from "@/components/gbp-sign-in-link";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, ConfirmFailureShown } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { answerLostText } from "@/lib/answerLost";
import { cn } from "@/lib/cn";
import { gbpSignInUrl } from "@/lib/gbpSignIn";
import { withWorkspaceId } from "@/lib/workspaceChanged";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { asksReload, canRetry, readApiError, shownError, signInHref, type ShownError } from "@/components/reviews/api-error";
import { ErrorState } from "@/components/reviews/error-state";
import { ReviewsEmptyState } from "@/components/reviews/reviews-empty-state";
import { APP_PAGE_CLASS } from "@/lib/pageLayout";
import { REPLY_TOO_LONG_MESSAGE, replyTooLong } from "@/lib/reviewReplyLength";
import { initialLocation } from "@/components/reviews/initial-location";
import { latestRequests, loadReviewsFor } from "@/components/reviews/load-reviews";
import { LocationPicker } from "@/components/reviews/location-picker";
import {
  draftingAfterEnd,
  draftingAfterStart,
  EMPTY_REPLY_BOXES,
  focusBoxAfterCardDraft,
  focusBoxOnOpen,
  hasTypedReply,
  openAfterDraft,
  replyRefusalAfterFailure,
  replyRefusalCleared,
  replyRefusalMessage,
  replyRefusalWhileOpen,
  replySignInHref,
  type ReplyRefusal,
  replyBoxAfterDraft,
  replyBoxAfterPost,
  replyBoxAfterTyping,
  replyBoxAfterUndo,
  type ReplyBoxes,
} from "@/components/reviews/reply-form";
import { ReviewCard } from "@/components/reviews/review-card";
import {
  focusAfterReply,
  needsReplyEmptyTitle,
  replyButtonId,
  reviewsCapNote,
  reviewsSubtitle,
  showLocationPicker,
  singleLocationName,
  tabLabel,
} from "@/components/reviews/reviews-page";
import type { GoogleReview, Location } from "@/components/reviews/types";
import { refusedPageView, workspaceChangedAfter } from "@/components/reviews/workspace-changed";
import { WorkspaceChangedNotice } from "@/components/reviews/workspace-changed-notice";

import { ReviewLinkPanel } from "./review-link-panel";

// F7 (R1 M5): plain sentences for a failure the route did not explain.
const LOCATIONS_FAILED = "Couldn't load your Google locations. Try again in a minute.";
const REPLY_FAILED = "Couldn't post your reply. Try again in a minute.";
/**
 * R28 pages L1: the answer can be lost after Google took the reply, so it may
 * be posted. Lead review: no reload (it would throw away the typed reply);
 * a reply is a PUT that replaces any earlier one, so sending again is safe.
 */
export const REPLY_ANSWER_LOST_MESSAGE = answerLostText(
  "your reply may have been posted",
  "Then press Post reply again: it replaces any reply already posted, so it won't post twice.",
);

/**
 * KK3: what a failed reply says, in its toast and its form's status line. A
 * request that got no answer (lib/requestNoAnswer) says so; anything else is
 * the route's sentence or REPLY_FAILED (api-error shownError).
 */
export function replyFailureShown(error: unknown): ShownError {
  return isNoAnswer(error) ? { message: REPLY_ANSWER_LOST_MESSAGE, settingsLink: false } : shownError(error, REPLY_FAILED);
}
/**
 * R28 lead follow-up: a draft lands only on the location it was pressed on.
 * One that comes back after another location was picked is dropped, as a late
 * list answer is (load-reviews.ts): its review's form would open hidden, and
 * its text would replace whatever was typed in that box.
 */
export function draftStillShown(pressedOn: string | null, current: string | null): boolean {
  return pressedOn === current;
}
const DRAFT_FAILED = "The AI could not write a reply. Try again, or write one yourself.";
export const DRAFT_OFFLINE_MESSAGE =
  "We couldn't reach Vibe Socials, so no draft was written. Check your connection and try again.";

/** R26 client-journey L5: what a failed AI draft says; a request that got no answer says so. */
export function draftFailureMessage(error: unknown): string {
  return isNoAnswer(error) ? DRAFT_OFFLINE_MESSAGE : shownError(error, DRAFT_FAILED).message;
}

/**
 * R26 client-journey L3: whether the locations answer asks an owner for the
 * in-place sign-in with its notice (an empty listing: GBP_NO_LISTING_NOTICE).
 * Only the flag is read; the link is built from the page's workspace.
 */
export function locationsSignIn(data: { notice?: unknown; signIn?: unknown } | null, isMember: boolean): boolean {
  return !isMember && data?.signIn === true && typeof data.notice === "string" && data.notice !== "";
}

const HEADING_CLASS = "text-2xl font-bold tracking-tight text-foreground outline-none";

/** R13-pages L1: skeletons are hidden, so loading is said in words (as Activity and Queue). */
export function ReviewsLoadingList() {
  return (
    <>
      <p role="status" className="sr-only">Loading reviews…</p>
      <div className="space-y-4" aria-hidden>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </>
  );
}

/**
 * R25 pages L4: the locations route's notice. Lead review: a live region that
 * first appears already filled may not be announced, so it is drawn from the
 * loading view on (same key under the same page element) and only its text changes.
 * R26 client-journey L3: with the owner's sign-in when the answer asks for it.
 */
export function LocationsNotice({ notice, signInUrl }: { notice: string | null; signInUrl: string | null }) {
  return (
    <div role="status" className="mb-6 flex flex-col items-start gap-3 empty:mb-0 empty:sr-only">
      {notice ? <p className="text-sm text-muted-foreground">{notice}</p> : null}
      {notice && signInUrl ? <SignInAgainLink href={signInUrl} /> : null}
    </div>
  );
}

/** R13-pages L1: a failed locations load (an expired Google grant can last) keeps the page's h1. */
export function ReviewsLoadFailedPage({
  error,
  isMember,
  onRetry,
  workspaceId,
}: {
  error: ShownError;
  isMember: boolean;
  onRetry: () => void;
  /** The workspace this page was drawn for: the in-place sign-in names it (lib/gbpSignIn.ts). */
  workspaceId: string;
}) {
  return (
    <div className={APP_PAGE_CLASS}>
      <h1 className={cn(HEADING_CLASS, "mb-8")}>Google Reviews</h1>
      <ErrorState
        title="Couldn't load reviews"
        message={error.message}
        settingsLink={error.settingsLink}
        signInUrl={signInHref(error, workspaceId)}
        isMember={isMember}
        onRetry={canRetry(error) ? onRetry : undefined}
      />
    </div>
  );
}

/**
 * Client-rendered reviews view. The parent server component gates access.
 * `savedLocation`: the Google location Settings saved for posts; the view
 * opens on it when Google lists it. Picking another one is not saved.
 * `isMember` (from the page's workspace context): a member is told who can
 * connect or reconnect Google, never sent to Settings (R12 L1).
 */
export function ReviewsView({
  savedLocation,
  isMember,
  workspaceId,
}: {
  savedLocation: string | null;
  isMember: boolean;
  /** JJ3 lead review: the workspace the page was drawn for, for the in-place Google sign-in. */
  workspaceId: string;
}) {
  const toast = useToast();

  const [reviews, setReviews] = useState<GoogleReview[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  // Whether a Google Business Profile connection exists at all. Separates the
  // two zero-location cases: "nothing connected yet" (offer the connect CTA)
  // vs "connected, but Google returned no locations" (a CTA wouldn't help).
  const [gbpConnected, setGbpConnected] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingLocations, setLoadingLocations] = useState(true);
  // F7: a sentence and whether it asks for a reconnect (api-error.ts).
  const [locationsError, setLocationsError] = useState<ShownError | null>(null);
  // R25 pages L4: the route's sentence about accounts whose locations Google would not send.
  const [locationsNotice, setLocationsNotice] = useState<string | null>(null);
  // R26 client-journey L3: the answer asked an owner to sign in again with its notice.
  const [locationsSignInAsked, setLocationsSignInAsked] = useState(false);
  const locationsSignInUrl = locationsSignInAsked ? gbpSignInUrl(workspaceId) : null;
  const [reviewsError, setReviewsError] = useState<ShownError | null>(null);
  // Google had more than the page loads: only the latest are shown.
  const [truncated, setTruncated] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  // The reply boxes and, after an AI draft replaced typed text, that text for Undo.
  const [replyBoxes, setReplyBoxes] = useState<ReplyBoxes>(EMPTY_REPLY_BOXES);
  const replyText = replyBoxes.text;
  const [submitting, setSubmitting] = useState<string | null>(null);
  // The reviews whose AI draft is being written; each box locks until its own lands.
  const [generatingAI, setGeneratingAI] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<"needs_reply" | "replied">("needs_reply");
  const [confirmTarget, setConfirmTarget] = useState<GoogleReview | null>(null);
  // After a reply posts or a form is cancelled: where keyboard focus goes (a
  // review's Reply button, or null for the heading). The success toast already
  // announces the reply.
  const [pendingFocus, setPendingFocus] = useState<{ reviewId: string | null } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // JJ3 lead review, R25 pages L4: the review whose reply failed, why, and
  // whether its form offers the owner the in-place sign-in.
  const [replyRefusal, setReplyRefusal] = useState<ReplyRefusal | null>(null);
  // R25 pages L1: the review the person opened with "Reply to review"; its box takes focus once open.
  const [boxFocusOnOpen, setBoxFocusOnOpen] = useState<string | null>(null);
  // JJ3 lead review: where focus was as a draft landed, decided once its box is
  // open (focusBoxAfterCardDraft): the card's Draft button leaves with it.
  const [boxFocusAfterDraft, setBoxFocusAfterDraft] = useState<{ reviewId: string; activeId: string } | null>(null);
  // R27 client-journey L1: only the latest reviews request may fill the list.
  const [nextReviewsRequest] = useState(latestRequests);
  // R27 security-billing L1: a request was refused because this page was drawn
  // for another workspace; the notice offers Reload, which takes focus. "load":
  // the locations or the list (the list is not shown); "press": a reply or
  // draft (the list and typed text stay, so the notice says to copy it first).
  const [workspaceChanged, setWorkspaceChanged] = useState<"load" | "press" | null>(null);
  const refused = refusedPageView(workspaceChanged, selectedLocation, hasTypedReply(replyText));
  const listRefused = refused.hideList;
  // The location whose reviews are on screen: a refused list for another one puts the selection back to it.
  const shownLocation = useRef<string | null>(null);
  const reloadRef = useRef<HTMLButtonElement>(null);
  // Set only by a refusal, so Reload takes focus right after it and never on a later dialog Cancel.
  const [reloadFocusPending, setReloadFocusPending] = useState(false);
  const refuseForWorkspace = (kind: "load" | "press") => {
    setWorkspaceChanged((prev) => workspaceChangedAfter(prev, kind));
    setReloadFocusPending(true);
  };

  // Every change of the open form but a draft landing (which opens one only
  // when none is open) comes here, so a closed form's refusal never comes back.
  const openReply = (next: string | null) => {
    setReplyingTo(next);
    setReplyRefusal((prev) => replyRefusalWhileOpen(prev, next));
  };

  // R28 client-journey L2: a form left open on another location's review is
  // hidden but still "open", so a Draft here would not open its own box.
  const chooseLocation = (location: string) => {
    setSelectedLocation(location);
    openReply(null);
  };

  const loadLocations = useCallback(async () => {
    try {
      setLoadingLocations(true);
      setLocationsError(null);
      setLocationsNotice(null);
      setLocationsSignInAsked(false);
      const response = await fetch(withWorkspaceId("/api/reviews/locations", workspaceId));

      if (!response.ok) {
        throw await readApiError(response, LOCATIONS_FAILED);
      }

      const data = await response.json();
      const locs: Location[] = data.locations || [];
      setLocations(locs);
      setGbpConnected(data.connected === true);
      setLocationsNotice(typeof data.notice === "string" && data.notice ? data.notice : null);
      setLocationsSignInAsked(locationsSignIn(data, isMember));

      // The saved location when listed, else the only one; else the person picks.
      const initial = initialLocation(locs, savedLocation);
      if (initial) {
        setSelectedLocation(initial);
      }
    } catch (err: unknown) {
      console.error("Error fetching locations:", err);
      const shown = shownError(err, LOCATIONS_FAILED);
      if (shown.reload) refuseForWorkspace("load");
      else setLocationsError(shown);
    } finally {
      setLoadingLocations(false);
    }
  }, [savedLocation, isMember, workspaceId]);

  const loadReviews = useCallback(async () => {
    // Once the page knows it belongs to another workspace, nothing is asked for until Reload.
    if (!selectedLocation || workspaceChanged) return;
    const location = selectedLocation;
    setLoading(true);
    setReviewsError(null);
    await loadReviewsFor(location, workspaceId, nextReviewsRequest(), (outcome) => {
      if ("error" in outcome) {
        if (outcome.error.reload) {
          refuseForWorkspace("load");
          setSelectedLocation(shownLocation.current);
        } else setReviewsError(outcome.error);
      } else {
        setReviews(outcome.reviews);
        setTruncated(outcome.truncated);
        shownLocation.current = location;
      }
      setLoading(false);
    });
  }, [selectedLocation, workspaceId, nextReviewsRequest, workspaceChanged]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    loadLocations();
  }, [loadLocations]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load-on-mount effect; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
    loadReviews();
  }, [loadReviews]);

  // Runs once the confirm dialog has closed: its own focus restore points at the
  // Post reply button, which left with the answered review.
  useEffect(() => {
    if (!pendingFocus || confirmTarget) return;
    const target = pendingFocus.reviewId
      ? document.getElementById(replyButtonId(pendingFocus.reviewId))
      : null;
    (target ?? headingRef.current)?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot focus request, cleared once used
    setPendingFocus(null);
  }, [pendingFocus, confirmTarget]);

  // As pendingFocus: once the confirm dialog has closed, so its own restore doesn't win.
  useEffect(() => {
    if (!reloadFocusPending || confirmTarget) return;
    reloadRef.current?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot focus request, cleared once used
    setReloadFocusPending(false);
  }, [reloadFocusPending, confirmTarget]);

  useEffect(() => {
    if (!boxFocusAfterDraft) return;
    if (focusBoxAfterCardDraft(boxFocusAfterDraft.activeId, boxFocusAfterDraft.reviewId, replyingTo)) {
      document.getElementById("review-reply")?.focus();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot focus request, cleared once used
    setBoxFocusAfterDraft(null);
  }, [boxFocusAfterDraft, replyingTo]);

  useEffect(() => {
    if (!boxFocusOnOpen) return;
    if (focusBoxOnOpen(boxFocusOnOpen, replyingTo)) {
      document.getElementById("review-reply")?.focus();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot focus request, cleared once used
    setBoxFocusOnOpen(null);
  }, [boxFocusOnOpen, replyingTo]);

  // Validate, then ask for confirmation before posting a public reply.
  const requestReply = (review: GoogleReview) => {
    const comment = replyText[review.reviewId]?.trim();

    if (!comment) {
      toast.error("Please enter a reply message");
      return;
    }
    // R17 L1: the reply box disables Post too; this is the same rule.
    if (replyTooLong(comment)) {
      toast.error(REPLY_TOO_LONG_MESSAGE);
      return;
    }

    setConfirmTarget(review);
  };

  // Posts the reply. Invoked from the ConfirmDialog's onConfirm — on failure
  // it toasts, notes it in the form, then throws ConfirmFailureShown, which
  // keeps the dialog open for a retry without a second message (the dialog's
  // contract), unless a retry can't change the answer;
  // on success it updates local state and lets the dialog close.
  const performReply = async (review: GoogleReview) => {
    const comment = replyText[review.reviewId]?.trim();
    if (!comment || replyTooLong(comment)) {
      return;
    }

    try {
      setSubmitting(review.reviewId);
      setReplyRefusal((prev) => replyRefusalCleared(prev, review.reviewId));

      const response = await fetchOrNoAnswer(`/api/reviews/${review.reviewId}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          comment,
          reviewName: review.name, // Pass full review name for API
          workspaceId,
        }),
      });

      if (!response.ok) {
        throw await readApiError(response, REPLY_FAILED);
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
      setReplyBoxes((prev) => replyBoxAfterPost(prev, review.reviewId));
      openReply(null);

      toast.success("Reply posted successfully!");
      setPendingFocus({
        reviewId: focusAfterReply(
          needsReplyReviews.map((r) => r.reviewId),
          review.reviewId
        ),
      });
    } catch (err: unknown) {
      console.error("Error posting reply:", err);
      const shown = replyFailureShown(err);
      // The typed reply stays in its box either way. A page drawn for another
      // workspace says so once, in the notice.
      if (shown.reload) {
        refuseForWorkspace("press");
      } else {
        toast.error(shown.message);
        setReplyRefusal(replyRefusalAfterFailure(review.reviewId, shown, isMember));
      }
      // A reply a retry can't change (a 403) lets the dialog close; its form keeps the sentence.
      if (canRetry(shown)) throw new ConfirmFailureShown("REPLY_FAILED");
    } finally {
      setSubmitting(null);
    }
  };

  // The location picked now, for a draft that lands later (draftStillShown).
  const selectedLocationRef = useRef<string | null>(null);
  useEffect(() => {
    selectedLocationRef.current = selectedLocation;
  }, [selectedLocation]);

  const handleDraftAI = async (review: GoogleReview) => {
    const pressedOn = selectedLocation;
    try {
      setGeneratingAI((prev) => draftingAfterStart(prev, review.reviewId));

      const response = await fetchOrNoAnswer("/api/reviews/draft-response", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reviewerName: review.reviewer.displayName,
          starRating: review.starRating,
          comment: review.comment || "",
          businessName: "", // Can be configured later
          workspaceId,
        }),
      });

      if (!response.ok) {
        throw await readApiError(response, DRAFT_FAILED);
      }

      const data = await response.json();
      const draftResponse = data.draftResponse;
      // Another location was picked meanwhile: dropped, nothing opened or replaced.
      if (!draftStillShown(pressedOn, selectedLocationRef.current)) return;

      // Populate the reply text box with AI-generated response.
      // Typed text it replaces is kept for Undo (reply-form.tsx).
      setReplyBoxes((prev) => replyBoxAfterDraft(prev, review.reviewId, draftResponse));

      // Opens this review's box only when none is open, judged now, not when
      // Draft was pressed: a box the person opened meanwhile stays theirs.
      setReplyingTo((open) => openAfterDraft(open, review.reviewId));
      setBoxFocusAfterDraft({ reviewId: review.reviewId, activeId: document.activeElement?.id ?? "" });
    } catch (err: unknown) {
      console.error("Error generating AI response:", err);
      if (asksReload(err)) refuseForWorkspace("press");
      else toast.error(draftFailureMessage(err));
    } finally {
      setGeneratingAI((prev) => draftingAfterEnd(prev, review.reviewId));
    }
  };

  const needsReplyReviews = reviews.filter((r) => !r.reviewReply);
  const repliedReviews = reviews.filter((r) => r.reviewReply);

  const renderReviewCard = (review: GoogleReview, needsReply: boolean) => (
    <ReviewCard
      key={review.reviewId}
      review={review}
      needsReply={needsReply}
      isReplyOpen={replyingTo === review.reviewId}
      isSubmitting={submitting === review.reviewId}
      isGeneratingAI={generatingAI.has(review.reviewId)}
      replyValue={replyText[review.reviewId] || ""}
      onOpenReply={() => {
        openReply(review.reviewId);
        setBoxFocusOnOpen(review.reviewId);
      }}
      onCloseReply={() => {
        openReply(null);
        setPendingFocus({ reviewId: review.reviewId });
      }}
      onChangeReply={(value) => {
        setReplyBoxes((prev) => replyBoxAfterTyping(prev, review.reviewId, value));
        setReplyRefusal((prev) => replyRefusalCleared(prev, review.reviewId));
      }}
      replySignInUrl={replySignInHref(replyRefusal, review.reviewId, workspaceId)}
      replyRefusal={replyRefusalMessage(replyRefusal, review.reviewId)}
      onUndoDraft={
        replyBoxes.undo[review.reviewId] !== undefined
          ? () => setReplyBoxes((prev) => replyBoxAfterUndo(prev, review.reviewId))
          : undefined
      }
      onSubmitReply={() => requestReply(review)}
      onDraftAI={() => handleDraftAI(review)}
    />
  );

  if (loadingLocations) {
    return (
      <div className={APP_PAGE_CLASS}>
        <h1 className={cn(HEADING_CLASS, "mb-8")}>Google Reviews</h1>
        <LocationsNotice key="locations-notice" notice={locationsNotice} signInUrl={locationsSignInUrl} />
        <WorkspaceChangedNotice key="workspace-changed" shown={workspaceChanged !== null} copyHint={refused.copyHint} reloadRef={reloadRef} />
        <ReviewsLoadingList />
      </div>
    );
  }

  if (locationsError) {
    return (
      <ReviewsLoadFailedPage
        error={locationsError}
        isMember={isMember}
        onRetry={loadLocations}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <div className={APP_PAGE_CLASS}>
      {/* Header */}
      <div className="mb-8">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className={HEADING_CLASS}
        >
          Google Reviews
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {reviewsSubtitle(
            selectedLocation && !loading && !reviewsError && !listRefused ? needsReplyReviews.length : null,
            reviews.length
          )}
        </p>
        {selectedLocation && !loading && !reviewsError && !listRefused && reviewsCapNote(truncated) && (
          <p className="mt-1 text-sm text-muted-foreground">{reviewsCapNote(truncated)}</p>
        )}
        {singleLocationName(locations) && (
          <p className="mt-1 text-sm text-muted-foreground">{singleLocationName(locations)}</p>
        )}
      </div>

      {/* Location Selector */}
      {showLocationPicker(locations) && (
        <LocationPicker
          locations={locations}
          selectedLocation={selectedLocation}
          onChange={chooseLocation}
          locked={refused.locked}
        />
      )}

      <LocationsNotice key="locations-notice" notice={locationsNotice} signInUrl={locationsSignInUrl} />
      <WorkspaceChangedNotice key="workspace-changed" shown={workspaceChanged !== null} copyHint={refused.copyHint} reloadRef={reloadRef} />

      {/* Tabs */}
      {selectedLocation && !reviewsError && !listRefused && (
        <div className="mb-6">
          <div
            role="group"
            aria-label="Review filter"
            className="inline-flex flex-wrap gap-0.5 rounded-[var(--radius)] border border-input p-0.5"
          >
            {(
              [
                ["needs_reply", tabLabel("Needs reply", loading ? null : needsReplyReviews.length)],
                ["replied", tabLabel("Replied", loading ? null : repliedReviews.length)],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                className={cn(
                  "rounded-[calc(var(--radius)-0.125rem)] px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  tab === value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Reviews List */}
      {/* With accounts left unread, "no locations yet" would be untrue: the notice says what happened. */}
      {listRefused ? null : !selectedLocation && locations.length === 0 && locationsNotice ? null : !selectedLocation ? (
        <ReviewsEmptyState locationsCount={locations.length} gbpConnected={gbpConnected} isMember={isMember} />
      ) : reviewsError ? (
        <ErrorState
          title="Couldn't load reviews"
          message={reviewsError.message}
          settingsLink={reviewsError.settingsLink}
          signInUrl={signInHref(reviewsError, workspaceId)}
          isMember={isMember}
          onRetry={canRetry(reviewsError) ? loadReviews : undefined}
        />
      ) : loading ? (
        <ReviewsLoadingList />
      ) : tab === "needs_reply" ? (
        needsReplyReviews.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 border-success/30 bg-success/5 px-6 py-12 text-center">
            <div
              aria-hidden
              className="flex h-12 w-12 items-center justify-center rounded-full bg-success/15 text-success"
            >
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-semibold text-foreground">
                {needsReplyEmptyTitle(reviews.length)}
              </h3>
              <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                To get more, send customers your review link from Get more reviews below.
              </p>
            </div>
          </Card>
        ) : (
          <div className="space-y-4">
            {needsReplyReviews.map((review) => renderReviewCard(review, true))}
          </div>
        )
      ) : repliedReviews.length === 0 ? (
        <EmptyState
          icon={<MessageSquare />}
          title="No replies yet"
          description="Reviews you've replied to will appear here."
        />
      ) : (
        <div className="space-y-4">
          {repliedReviews.map((review) => renderReviewCard(review, false))}
        </div>
      )}

      {/* 2026-11-10: the review link, QR code, print card and message. Only once
          Google is connected: before that the page offers the connect step.
          N2: below the list, since people come here to answer reviews. */}
      {gbpConnected && (
        <ReviewLinkPanel
          workspaceId={workspaceId}
          isMember={isMember}
          // One sign-in button per page: the locations notice's or the reviews
          // error card's, when one shows it.
          signInShownAbove={Boolean(locationsSignInUrl || (reviewsError && signInHref(reviewsError, workspaceId)))}
          workspaceNoticeShownAbove={workspaceChanged !== null}
        />
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title="Post this reply publicly?"
        description="It will appear on your Google Business Profile listing for everyone to see."
        confirmText="Post reply"
        onConfirm={async () => {
          if (confirmTarget) await performReply(confirmTarget);
        }}
      />
    </div>
  );
}
