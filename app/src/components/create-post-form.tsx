"use client";

import { useState, useEffect, useEffectEvent, useMemo, useRef, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { upload } from '@vercel/blob/client';
import { explainUploadFailure, UploadRefusedError } from "@/lib/uploadFailure";
import { PlugZap, Sparkles } from "lucide-react";
import type { Platform } from "@prisma/client";
import {
  AddPhotosButton,
  AttachedPhotos,
  patchPhoto,
  PhotoDescriptionField,
  photoSetReady,
  preparePhotos,
  removeAllClearsCaption,
  requestPhotoDescription,
  uploadPhotosInOrder,
  whereDescriptionGoes,
  withPhotoDescriptions,
  type AttachedPhoto,
} from "./composer/attached-photos";
import { PlatformCaptionEditor } from "./composer/platform-caption-editor";
import { PlatformPreviewList } from "./composer/platform-preview";
import { PublishBar, type SubmitControlView } from "./composer/publish-bar";
import { LocationAutocomplete } from "./location-autocomplete";
import { TikTokConsentDeclaration, TikTokPostSettings } from "./tiktok-post-settings";
import { YouTubePostSettings } from "./youtube-post-settings";
import { GooglePostSettings } from "./google-post-settings";
import { StoryPlacementSettings } from "./story-placement";
import { CaptionCounter } from "@/components/caption-counter";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { fieldBaseClasses, Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import { useConnections } from "@/hooks/useConnections";
import { generateBlobKey } from "@/lib/blobKey";
import type { CaptionFooterUser } from "@/lib/captionFooter";
import { captionCounter, captionTooLongMessage } from "@/lib/captionLimits";
import { cn } from "@/lib/cn";
import { composerPublishConfirmCopy, type ComposerConfirmCopy } from "@/lib/composerConfirm";
import { deriveComposerGate } from "@/lib/composerGate";
import {
  COMPOSER_DISPATCH_FAILED_MESSAGE,
  composerSubmitOutcome,
} from "@/lib/composerSubmitOutcome";
import {
  buildPhotosPostBody,
  buildReusePostBody,
  buildUploadPostBody,
  type CreatePostMediaRequest,
  type CreatePostRequest,
  type CreatePostReuseRequest,
  type DeferredPostFields,
} from "@/lib/createPostRequest";
import type { MediaItemDto } from "@/lib/mediaDto";
import { cleanPlatformOverrides, type PlatformOverrides } from "@/lib/platformOverrides";
import {
  addPhotos,
  MAX_POST_MEDIA,
  movePhoto,
  MULTI_PHOTO_MIME_TYPES,
  multiPhotoPlatformNotes,
  photoPickProblem,
  removePhoto,
} from "@/lib/postMedia";
import { isHeicFile, prepareUploadFile } from "@/lib/prepareUploadFile";
import { platformAcceptsTextOnly, textPostsEnabled } from "@/lib/platformLimits";
import { shouldTakeSharedFile, takeSharedFile } from "@/lib/sharedFile";
import { TIKTOK_DISCLOSURE_INCOMPLETE_TEXT, tiktokPublishBlock } from "@/lib/tiktokPostRules";
import {
  initialPlacements,
  reconcilePlacement,
  storyOnlyCaptionNote,
  storyVideoLengthRefusal,
  type PlacementChoice,
} from "@/lib/storyPlacement";
import {
  PLATFORM_ORDER,
  platformLabel,
  SETTINGS_CONNECTIONS_HREF,
  TIKTOK_PRIVACY_LABELS,
} from "@/lib/platforms";
import { extractVideoFrames } from "@/lib/extractVideoFrames";
import {
  deriveComposerPlatforms,
  isTikTokPrivacyMissing,
  TEXT_POST_EMPTY_MESSAGE,
  TIKTOK_PRIVACY_REQUIRED_MESSAGE,
} from "@/lib/postTargets";
import {
  SCHEDULE_BUFFER_MS,
  localDateTimeToUtcIso,
  localTimeZoneLabel,
  toDateTimeLocalValue,
} from "@/lib/scheduling";
import type {
  GoogleBusinessPostMetadata,
  TikTokPostMetadata,
  YouTubePostMetadata,
} from "@/server/platforms/types";
import type { GoogleButton } from "@/lib/googlePostOptions";
import {
  REPEAT_DEFAULT_COUNT,
  REPEAT_MAX_COUNT,
  REPEAT_MIN_COUNT,
  REPEAT_STORY_MESSAGE,
  REPEAT_X_NOTE,
  repeatRefusalText,
  repeatSchedule,
  type RepeatInterval,
} from "@/lib/repeatSchedule";
import { nextFreeSlots, type PostingSlot } from "@/lib/postingSlots";

interface UploadedBlobInfo {
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

// Roadmap Phase 5 — how the composer wants to publish. `now` is the original
// immediate flow; `schedule` sends a `scheduledFor` (UTC ISO); `draft` sends
// `draft: true`. Both deferred modes create no results / send no event now.
type PublishMode = "now" | "schedule" | "draft";

/**
 * Posts without a photo (2026-11-10): the page is writing a text post when no
 * file is attached and no library item is still loading (`?mediaItemId=`).
 */
export function hasNoFile(state: {
  reuseLoading: boolean;
  hasReuseItem: boolean;
  hasUploadFile: boolean;
  photoCount: number;
  /** A single pick still being prepared (HEIC conversion, shrinking) is a file. */
  preparingFile?: boolean;
  /** A file shared into the app (?shared=1) that has not arrived yet is a file. */
  sharedFilePending?: boolean;
}): boolean {
  return (
    !state.preparingFile &&
    !state.sharedFilePending &&
    !state.reuseLoading &&
    !state.hasReuseItem &&
    !state.hasUploadFile &&
    state.photoCount === 0
  );
}

/**
 * The page is writing a text post: no file, and posts without a photo are
 * switched on (platformLimits.ts textPostsEnabled). Switched off, the page is
 * exactly the one where a file is required.
 */
export function isTextPostMode(
  state: Parameters<typeof hasNoFile>[0],
  /** The switch value; the form passes the one read at load. Absent: read it now. */
  enabled?: boolean,
): boolean {
  return (enabled ?? textPostsEnabled()) && hasNoFile(state);
}

/**
 * Which page the person sees. "untouched" (no file and no text anywhere) looks
 * like the page with a file: the main thing people do there is add a photo, so
 * greying out the photo platforms before anything is written reads wrong.
 */
export type ComposerPageState = "untouched" | "text" | "file";

export function composerPageState(
  state: Parameters<typeof hasNoFile>[0] & {
    caption: string;
    overrides: PlatformOverrides | null;
    connected: readonly Platform[];
    deselected: ReadonlySet<Platform>;
  },
  enabled?: boolean,
): ComposerPageState {
  if (!isTextPostMode(state, enabled)) return "file";
  // A platform's own caption is text only where it would be sent: a connected,
  // ticked platform that takes text alone. Instagram's would make a text post
  // that greys Instagram out and hides its box; an unticked X's caption is not
  // on the page, so nothing would say why the page is a text post.
  const hasText =
    state.caption.trim() !== "" ||
    (Object.entries(state.overrides ?? {}) as [Platform, string | undefined][]).some(
      ([platform, text]) =>
        platformAcceptsTextOnly(platform) &&
        state.connected.includes(platform) &&
        !state.deselected.has(platform) &&
        (text ?? "").trim() !== "",
    );
  return hasText ? "text" : "untouched";
}

export const UNTOUCHED_SUBMIT_MESSAGE = "Add a photo or video, or write the text of your post.";
/** Where no connected platform takes text alone, offering text would lead nowhere. */
export const UNTOUCHED_FILE_ONLY_MESSAGE = "Add a photo or video.";

/** The sentence by the button after a press on the untouched page, or null. */
export function untouchedSubmitMessage(state: {
  untouched: boolean;
  pressed: boolean;
  connected: readonly Platform[];
}): string | null {
  if (!state.untouched || !state.pressed) return null;
  const textGoesNowhere = state.connected.length > 0 && !state.connected.some(platformAcceptsTextOnly);
  return textGoesNowhere ? UNTOUCHED_FILE_ONLY_MESSAGE : UNTOUCHED_SUBMIT_MESSAGE;
}

/**
 * Does this press count as a try for the platform-list alert? Not on the
 * untouched page: the post was not written yet, so the first letter typed
 * after it must not bring up a red line.
 */
export function pressCountsAsTry(pageState: ComposerPageState): boolean {
  return pageState !== "untouched";
}

/**
 * What the page shows for its state. The form takes all of it from here, so
 * which of these wait for text (only a text post greys out the photo platforms,
 * shows the notice and renames the button) is decided, and tested, in one place.
 */
export function composerPageView(input: {
  pageState: ComposerPageState;
  connected: readonly Platform[];
  deselected: ReadonlySet<Platform>;
  mimeType: string | null;
  mode: PublishMode;
  loading: boolean;
  triedSend: boolean;
}) {
  const textPage = input.pageState === "text";
  const { choices, selected } = deriveComposerPlatforms(input.connected, input.deselected, input.mimeType, {
    noFile: textPage,
  });
  const allDisabled = choices.every((choice) => choice.disabledReason !== null);
  return {
    /** No file (switch on): the lost-file notice, Location and the rest keep reading this. */
    noFile: input.pageState !== "file",
    untouched: input.pageState === "untouched",
    choices,
    selected,
    allDisabled,
    platformAlert: platformListAlert({
      selectedCount: selected.length,
      allDisabled,
      noFile: textPage,
      triedSend: input.triedSend,
    }),
    textNotice: textOnlyNotice({ noFile: textPage, connected: input.connected, deselected: input.deselected, selected }),
    buttonLabel: submitButtonLabel({ mode: input.mode, noFile: textPage, loading: input.loading }),
    // Untouched, the page may still get a file: Location and X's note stay as with one.
    showLocation: showLocationField({ noFile: textPage }),
    repeatNote: repeatCautionNote({ noFile: textPage, xSelected: selected.includes("x") }),
  };
}

/**
 * The first decisions of a press, in the form's order: a fresh lost-file notice
 * stops it (the notice speaks), then a file still on its way (its wait
 * sentence), then the untouched page (the sentence by the button). Null: go on.
 */
export function submitFirstStep(state: {
  pageState: ComposerPageState;
  /** The lost-file notice as shown: "none" when it is not on the page. */
  fileLost: FileLostNotice;
  /** fileSubmitBlock for a single pick or a shared file still on its way, or null. */
  fileBlock: string | null;
}):
  | { stop: "file-lost" | "untouched" | null; countsAsTry: boolean }
  | { stop: "wait"; message: string; countsAsTry: boolean } {
  const countsAsTry = pressCountsAsTry(state.pageState);
  if (fileLostBlocksSubmit(state.fileLost)) return { stop: "file-lost", countsAsTry };
  if (state.fileBlock) return { stop: "wait", message: state.fileBlock, countsAsTry };
  if (state.pageState === "untouched") return { stop: "untouched", countsAsTry };
  return { stop: null, countsAsTry };
}

/**
 * Is a file shared into the Android app still on its way? The page was opened
 * with ?shared=1 and the take has not finished (attached, or found nothing).
 */
export function sharedFileOnItsWay(sharedParam: string | null, settled: boolean): boolean {
  return sharedParam === "1" && !settled;
}

/**
 * The caution under Repeat. A repeating text post sends the same text each
 * time, which platforms may refuse; with a file only X's caution applies.
 */
export function repeatCautionNote(state: { noFile: boolean; xSelected: boolean }): string | null {
  if (state.noFile) {
    return "Platforms may refuse a post whose text is the same as a recent one. Change the text of each repeat in the Queue.";
  }
  return state.xSelected ? REPEAT_X_NOTE : null;
}

/**
 * The line under the platform list when nothing is selected, or null. For a text
 * post whose connected platforms all need a file it waits until the person tries
 * to send: on load it would be a red alert about a post nobody has written yet.
 */
export function platformListAlert(state: {
  selectedCount: number;
  allDisabled: boolean;
  noFile: boolean;
  triedSend: boolean;
}): string | null {
  if (state.selectedCount > 0) return null;
  if (!state.allDisabled) return "Select at least one platform.";
  if (!state.noFile) return "None of your connected platforms can publish this media.";
  return state.triedSend ? "None of your connected platforms can publish a post without a photo or video." : null;
}

/** Location is read from a post's file (Instagram, YouTube), so a text post has no use for it. */
export function showLocationField(state: { noFile: boolean }): boolean {
  return !state.noFile;
}

/** "X", "X and LinkedIn", "Facebook Page, X and LinkedIn". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The submit button's text. In text mode it says plainly that the post has no
 * photo; with a file it is exactly what it was.
 */
export function submitButtonLabel(state: { mode: PublishMode; noFile: boolean; loading: boolean }): string {
  if (state.loading) {
    return state.mode === "draft" ? "Saving…" : state.mode === "schedule" ? "Scheduling…" : "Publishing…";
  }
  if (state.noFile) {
    return state.mode === "draft"
      ? "Save draft without a photo"
      : state.mode === "schedule"
        ? "Schedule without a photo"
        : "Publish without a photo";
  }
  return state.mode === "draft" ? "Save draft" : state.mode === "schedule" ? "Schedule post" : "Publish post";
}

/**
 * The submit control as the form's button and the phone's publish bar both
 * show it, so the two never disagree. Disabled for exactly what disabled the
 * form's button before (M1); the reason is the first sentence the page
 * already shows for why a press will not send.
 */
export function submitControl(input: {
  /** composerPageView's buttonLabel. */
  buttonLabel: string;
  loading: boolean;
  /** The main caption; over the cap it disables the button (captionCounter). */
  caption: string;
  tiktokBlock: string | null;
  /** fileSubmitBlock, or null. */
  fileBlock: string | null;
  untouchedMessage: string | null;
  platformAlert: string | null;
}): SubmitControlView {
  const counter = captionCounter(input.caption);
  const reason =
    input.untouchedMessage ??
    input.platformAlert ??
    (counter.over ? `Caption is too long: ${counter.label} characters.` : null) ??
    (input.tiktokBlock ? `TikTok: ${input.tiktokBlock}` : null) ??
    input.fileBlock;
  return {
    label: input.buttonLabel,
    loading: input.loading,
    disabled: counter.over || input.tiktokBlock !== null || input.fileBlock !== null,
    reason,
  };
}

/**
 * The line above the buttons in text mode, built from the actual selection:
 * where the text goes, and which platforms that need a file are skipped (the
 * connected ones the person has not unticked). Null with a file, or when no
 * platform can take the post (the submit then says why).
 */
export function textOnlyNotice(state: {
  noFile: boolean;
  connected: readonly Platform[];
  deselected: ReadonlySet<Platform>;
  selected: readonly Platform[];
}): string | null {
  if (!state.noFile || state.selected.length === 0) return null;
  const goes = `This post has no photo or video. It goes to ${joinNames(state.selected.map(platformLabel))} as text only.`;
  const skipped = state.connected.filter(
    (platform) => !platformAcceptsTextOnly(platform) && !state.deselected.has(platform),
  );
  if (skipped.length === 0) return goes;
  const verb = skipped.length === 1 ? "needs a photo or video and is skipped." : "need a photo or video and are skipped.";
  return `${goes} ${joinNames(skipped.map(platformLabel))} ${verb}`;
}

/** Does this press ask first? Publish always; Schedule for a text post only; a draft never. */
export function needsSubmitConfirm(state: { mode: PublishMode; noFile: boolean }): boolean {
  if (state.mode === "now") return true;
  return state.mode === "schedule" && state.noFile;
}

/** The confirmation of a text post: the usual copy for Publish, plus the line. */
export function textPostConfirmCopy(input: {
  mode: "now" | "schedule";
  holdsForApproval: boolean;
  /** Display labels of the selected platforms, in order. */
  platforms: string[];
  notice: string | null;
  /** The chosen time as the person reads it; Schedule only. */
  whenText: string | null;
  /** How many posts a repeating post creates in all; absent or 1 when it does not repeat. */
  repeatCount?: number;
}): ComposerConfirmCopy & { notice: string | null } {
  if (input.mode === "now") {
    const base = composerPublishConfirmCopy({ holdsForApproval: input.holdsForApproval, platforms: input.platforms });
    return {
      ...base,
      notice: input.notice,
      confirmText: input.holdsForApproval ? base.confirmText : "Publish without a photo",
    };
  }
  const when = input.whenText ? ` ${input.whenText}` : "";
  // The dialog names the first time; a repeating post says how many more follow.
  const more = (input.repeatCount ?? 1) - 1;
  const repeats = more > 0 ? `, then repeats ${more} more ${more === 1 ? "time" : "times"}` : "";
  if (input.holdsForApproval) {
    return {
      title: "Submit for approval?",
      lead: `An owner will review this post before it publishes${when} to ${joinNames(input.platforms)}${repeats}.`,
      notice: input.notice,
      trail: null,
      confirmText: "Submit for approval",
    };
  }
  return {
    title: "Schedule without a photo?",
    lead: `It publishes${when} to ${joinNames(input.platforms)}${repeats}.`,
    notice: input.notice,
    trail: null,
    confirmText: "Schedule without a photo",
  };
}

/** The chosen schedule time as the confirmation says it, or null when none is valid. */
export function scheduleWhenText(scheduledForLocal: string): string | null {
  const iso = localDateTimeToUtcIso(scheduledForLocal);
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Shown, until a file is attached or dismissed, when a file went away by itself. */
export const FILE_LOST_MESSAGE = "The photo or video could not be added. Add it again, or continue without one.";

/**
 * The "file went away" notice: none, fresh (not yet pressed past), or seen (the
 * person pressed once with it showing). A toast fades; this stays, because the
 * caption stays and the page is now in text mode.
 */
export type FileLostNotice = "none" | "fresh" | "seen";

export type FileLostEvent =
  | { type: "lost"; reason: "prepare-failed" | "library-failed" | "photos-failed" }
  | { type: "attached" }
  | { type: "dismissed" }
  /** The form emptied by the person or after a post was saved: a new post starts clean. */
  | { type: "reset" }
  | { type: "pressed" };

export function nextFileLostNotice(current: FileLostNotice, event: FileLostEvent): FileLostNotice {
  if (event.type === "lost") return "fresh";
  if (event.type === "attached" || event.type === "dismissed" || event.type === "reset") return "none";
  return current === "fresh" ? "seen" : current;
}

export function fileLostNoticeShown(state: FileLostNotice): boolean {
  return state !== "none";
}

/**
 * Photos that could not be prepared take a file away only when nothing stays
 * attached: added beside photos that stay, nothing went away and no notice is due.
 */
export function photosFailureLosesFile(input: { attachedBefore: number }): boolean {
  return input.attachedBefore === 0;
}

/** The first press while the notice is fresh stops there, before any dialog. */
export function fileLostBlocksSubmit(state: FileLostNotice): boolean {
  return state === "fresh";
}

/**
 * Removing the last photo takes a caption the AI wrote for it, still unedited,
 * with it (as "Remove all" does), so it never goes out as a text post.
 */
export function lastPhotoRemovalClearsCaption(state: {
  remaining: number;
  caption: string;
  lastAiCaption: string | null;
}): boolean {
  return state.remaining === 0 && removeAllClearsCaption(state.caption, state.lastAiCaption);
}

/** The switch read once per page load, so rendering calls no function the compiler cannot see into. */
const TEXT_POSTS_ON = textPostsEnabled();

/** What happens to a single pick: picked, cleared (or replaced by photos), or prepared (or failed). */
export type PickEvent = { type: "pick"; selection: number } | { type: "clear" } | { type: "settled"; selection: number };

/**
 * The pick still being prepared, or null. Only the latest pick counts: an older
 * one settling after a newer pick, or after the pick was cleared, changes nothing.
 */
export function nextPreparingPick(current: number | null, event: PickEvent): number | null {
  if (event.type === "pick") return event.selection;
  if (event.type === "clear") return null;
  return current === event.selection ? null : current;
}

/** Why the file side of the form cannot be sent yet, or null. The submit buttons are disabled while it is set. */
export function fileSubmitBlock(state: {
  preparingFile: boolean;
  preparingPhotos: boolean;
  photosNotReady: boolean;
  sharedFilePending?: boolean;
}): string | null {
  if (state.sharedFilePending) return "Wait until the shared file has arrived, then press the button again.";
  if (state.preparingFile) return "Wait until the file is ready, then press the button again.";
  if (state.preparingPhotos) return "Wait until the photos are ready, then press the button again.";
  if (state.photosNotReady) return "Wait until every photo has uploaded, or remove the ones that failed.";
  return null;
}

/** Why a text post cannot be sent yet, or null. The file checks do not apply to it. */
export function noFileSubmitError(state: {
  caption: string;
  selectedCount: number;
  allDisabled: boolean;
}): string | null {
  if (!state.caption.trim()) return TEXT_POST_EMPTY_MESSAGE;
  if (state.selectedCount === 0) {
    return state.allDisabled
      ? "None of your connected platforms can publish a post without a photo or video. Add a photo or video."
      : "Select at least one platform to publish to.";
  }
  return null;
}

/** The POST /api/posts body of a text post: `textOnly` and none of the file fields. */
export interface CreateTextPostRequest extends DeferredPostFields {
  textOnly: true;
  baseCaption: string;
  platforms: Platform[];
  workspaceId: string;
  perPlatformOverrides?: Partial<Record<Platform, string>>;
  googleMetadata?: GoogleBusinessPostMetadata;
}

export function buildTextPostBody(input: {
  baseCaption: string;
  platforms: Platform[];
  deferred: DeferredPostFields;
  workspaceId: string;
  perPlatformOverrides?: Partial<Record<Platform, string>> | null;
  /** Pass only when Google Business Profile is a selected target. */
  googleMetadata?: GoogleBusinessPostMetadata;
}): CreateTextPostRequest {
  const body: CreateTextPostRequest = {
    textOnly: true,
    baseCaption: input.baseCaption,
    platforms: input.platforms,
    ...input.deferred,
    workspaceId: input.workspaceId,
  };
  // Cleaned the same way as the file bodies (lib/createPostRequest.ts).
  const overrides = cleanPlatformOverrides(input.perPlatformOverrides, input.baseCaption, input.platforms);
  if (overrides) body.perPlatformOverrides = overrides;
  if (input.googleMetadata) body.googleMetadata = input.googleMetadata;
  return body;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(1)} ${sizes[i]}`;
}

interface CreatePostFormInnerProps {
  /**
   * Roadmap Phase 7 — the posting user's footer settings (companyWebsite /
   * defaultHashtags), projected server-side (see app/posts/new/page.tsx) so
   * only these two display fields — never the full `User` row — reach this
   * client component. Optional: the live preview below still renders (minus
   * the footer) when this isn't provided.
   */
  footerSettings?: CaptionFooterUser;
  /**
   * 2026-11-01 audit — true for a member in a workspace that requires
   * approval: their publish-now is submitted for review, not published, so the
   * confirmation says so (see composerPublishConfirmCopy).
   */
  holdsForApproval?: boolean;
  /**
   * 2026-11-01 audit (M3) — the id of the workspace this page was rendered for
   * (app/posts/new/page.tsx). Sent with the create request so the server can
   * refuse when the active-workspace cookie was switched in another tab.
   * Required (final review, T9): a caller that forgets it would silently turn
   * the protection off, so the compiler rejects that instead.
   */
  workspaceId: string;
  /** 2026-11-10 — the workspace's default Google button; Google posts start from it. */
  googleButtonDefault?: GoogleButton | null;
}

function CreatePostFormInner({
  footerSettings,
  holdsForApproval = false,
  workspaceId,
  googleButtonDefault = null,
}: CreatePostFormInnerProps) {
  const toast = useToast();
  const searchParams = useSearchParams();

  // Roadmap Phase 2 — reuse mode. `?mediaItemId=` names an already-persisted
  // MediaItem (from the media library's "Use in new post" action) to attach
  // to a new post instead of uploading a fresh file. `reuseItem` (not the
  // presence of the query param) is the source of truth for whether the
  // reuse UI renders, so a failed fetch or an explicit "use a different file"
  // cleanly falls back to the normal upload flow below.
  const reuseMediaItemId = searchParams.get("mediaItemId");
  const [reuseItem, setReuseItem] = useState<MediaItemDto | null>(null);
  const [reuseLoading, setReuseLoading] = useState(() => Boolean(reuseMediaItemId));
  // A different caption per platform, as the user typed them, for both a fresh
  // upload and reused media (starts from the reused item's own captions). What
  // is sent and previewed is the cleaned form (lib/platformOverrides.ts).
  const [platformOverrides, setPlatformOverrides] = useState<PlatformOverrides | null>(null);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadCaption, setUploadCaption] = useState("");
  // 07c: the last caption the AI wrote from the media. "Remove all" clears the
  // caption box only while it still holds exactly this (removeAllClearsCaption).
  const [lastAiCaption, setLastAiCaption] = useState<string | null>(null);
  // 2026-11-01 scale audit (jobs, event size): over the 10,000-character cap, which
  // POST /api/posts rejects - blocks the submit (lib/captionLimits.ts).
  const captionOver = captionCounter(uploadCaption).over;
  const [uploadLocation, setUploadLocation] = useState("");
  const [uploadLoading, setUploadLoading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  // Whether the post just submitted included TikTok: its processing notice
  // (TikTok guideline 5d) must still show after the form resets.
  const [submittedToTikTok, setSubmittedToTikTok] = useState(false);
  const [enhancingCaption, setEnhancingCaption] = useState(false);

  const [autoCaptionEnabled, setAutoCaptionEnabled] = useState(true);
  const [autoCaptionLoading, setAutoCaptionLoading] = useState(false);
  const [uploadedBlob, setUploadedBlob] = useState<UploadedBlobInfo | null>(null);
  // 07d: the description (alt text) of a single photo, uploaded or reused. With
  // several photos each one keeps its own on its AttachedPhoto.
  const [singleAltText, setSingleAltText] = useState("");
  // The photo the single field is for right now (the picked File, or the reused
  // item), so a "Write it for me" answer finds its photo when it comes back.
  const singlePhotoRef = useRef<object | null>(null);

  // Roadmap Phase 5 — publish timing. `scheduledForLocal` is the raw
  // datetime-local (browser-local wall time) string; it's converted to a UTC
  // ISO `scheduledFor` only at submit. Works for both the upload and reuse flows.
  const [publishMode, setPublishMode] = useState<PublishMode>("now");
  const [scheduledForLocal, setScheduledForLocal] = useState("");
  // Earliest schedulable datetime-local value (now + buffer) for the picker's
  // `min`. A lazy useState initializer computes it once at mount, keeping the
  // impure `Date.now()` off the render path; submit-time validation is the
  // authoritative future-time check.
  const [minScheduleLocal] = useState(() =>
    toDateTimeLocalValue(new Date(Date.now() + SCHEDULE_BUFFER_MS)),
  );
  // Repeat (brief 11): Schedule mode only. Sent as `repeatAt`, the dates after
  // the first, worked out here in the viewer's zone (lib/repeatSchedule.ts).
  const [repeat, setRepeat] = useState<RepeatInterval | "none">("none");
  const [repeatCount, setRepeatCount] = useState(REPEAT_DEFAULT_COUNT);
  // Posting times and the times posts already hold, read once Schedule is
  // chosen (GET /api/posts/scheduled-times); "Next free slot" works from them.
  const [slotData, setSlotData] = useState<{ slots: PostingSlot[]; taken: Date[] } | "error" | null>(null);
  // How many times "Next free slot" was pressed since the time was last typed:
  // each press moves to the free slot after the one before.
  const [slotPresses, setSlotPresses] = useState(0);
  // The mode that produced the current success banner (so it reads correctly
  // for now / schedule / draft).
  const [submittedMode, setSubmittedMode] = useState<PublishMode>("now");
  // Approval workflow — set from the create response so the success copy tells
  // the truth for a held post (nothing is queued or scheduled yet).
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  // Final review M3 — the post was saved but its publishing never started
  // (503 DISPATCH_FAILED): the banner points at Activity to retry it.
  const [dispatchFailed, setDispatchFailed] = useState(false);
  // Task 7 — publish-now confirmation dialog. Immediate publishes can't be
  // undone once sent, so `handleUploadSubmit` opens this instead of posting
  // directly when `publishMode === "now"`; schedule/draft submit right away.
  const [confirmPublishOpen, setConfirmPublishOpen] = useState(false);
  // A file that went away by itself (FILE_LOST_MESSAGE): stays until a file is
  // attached or the person dismisses it (nextFileLostNotice).
  const [fileLost, setFileLost] = useState<FileLostNotice>("none");
  // Scrolled into view whenever the success banner appears (effect below) so
  // a submit from further down the form doesn't leave the confirmation
  // off-screen.
  const successRef = useRef<HTMLDivElement>(null);

  // Local object-URL preview for the currently attached file. Created/revoked
  // by the effect below so we never leak object URLs.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // 0-100 while a Blob upload is in flight for the active file; null when idle.
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  // Bumped after a successful post so React remounts the (uncontrolled) file
  // input (2026-11-01 audit): clearing `uploadFile` state alone leaves the
  // browser showing the old filename, and re-choosing that same file then fires
  // no change event - so submit said "Please choose a file to upload." Same
  // technique as media-library.tsx's `fileInputKey`.
  const [fileInputKey, setFileInputKey] = useState(0);

  // Tracks the in-flight/most recent Blob upload for the CURRENT file, keyed
  // by File identity. This guarantees a given file is uploaded to Vercel
  // Blob at most once: both the attach-time auto-caption path and the
  // submit path call ensureUploaded() and share this same promise instead
  // of independently starting a second upload. Selecting a different (or
  // no) file resets this ref, which invalidates any stale in-flight upload
  // so its result is never applied to the newly selected file.
  const activeUploadRef = useRef<{
    file: File;
    promise: Promise<UploadedBlobInfo>;
  } | null>(null);
  // Counts file picks. Preparing a pick (HEIC -> JPEG, shrinking a big photo)
  // is async, so a newer pick can finish first; an older pick that finishes
  // later sees a different count and is dropped.
  const fileSelectionRef = useRef(0);

  // 07c: two or more photos in one post. Empty for a single file, which keeps
  // today's path (uploadFile / ensureUploaded) untouched. The first is the cover.
  const [photoSet, setPhotoSet] = useState<AttachedPhoto[]>([]);
  // The set as of the last change, for the async queue: it checks that a
  // photo is still attached (and still the cover) before acting on it. Every
  // change goes through changePhotoSet so the two never differ.
  const photoSetRef = useRef<AttachedPhoto[]>([]);
  const changePhotoSet = (change: (prev: AttachedPhoto[]) => AttachedPhoto[]) => {
    const next = change(photoSetRef.current);
    photoSetRef.current = next;
    setPhotoSet(next);
  };
  // Leaving the page stops the photo queue: no further upload starts.
  const mountedRef = useRef(false);
  // A pick of several photos is being prepared (HEIC -> JPEG, shrinking).
  const [preparingPhotos, setPreparingPhotos] = useState(false);
  // The single pick still being prepared (nextPreparingPick), or null. While it
  // is set the page counts a file, so it never sends a text post by mistake.
  const [preparingPick, setPreparingPick] = useState<number | null>(null);
  // Switched off, the page keeps its earlier behaviour while a pick is prepared.
  const preparingFile = TEXT_POSTS_ON && preparingPick !== null;
  const [sharedSettled, setSharedSettled] = useState(false);
  // A file shared into the app (?shared=1) is a file until its take finishes
  // (sharedFileOnItsWay). Copied into a plain boolean: passing the expression
  // itself made the React compiler skip this component (lint).
  const sharedFilePending = TEXT_POSTS_ON && sharedFileOnItsWay(searchParams.get("shared"), sharedSettled);
  const sharedPendingNow = sharedFilePending === true;
  const photoKeyRef = useRef(0);
  // Chains every set upload so the photos upload one after another, retries too.
  const photoQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [tiktokMetadata, setTiktokMetadata] = useState<TikTokPostMetadata>({
    privacyLevel: "",
    disableComment: true,
    disableDuet: true,
    disableStitch: true,
  });
  const [tiktokPrivacyError, setTiktokPrivacyError] = useState<string | null>(null);
  const [tiktokCommercialEnabled, setTiktokCommercialEnabled] = useState(false);
  // TikTok guideline 1b/1c: why TikTok can't take this post (from the TikTok
  // panel), and the chosen video's length once the browser has read it.
  const [tiktokBlockingReason, setTiktokBlockingReason] = useState<string | null>(null);
  const [videoDurationSec, setVideoDurationSec] = useState<number | null>(null);

  const [youtubeMetadata, setYoutubeMetadata] = useState<YouTubePostMetadata>({
    privacyStatus: "unlisted",
  });
  // 2026-11-10 — a Google photo post's type and button, from the workspace default.
  const initialGoogleMetadata = (): GoogleBusinessPostMetadata =>
    googleButtonDefault ? { postType: "update", button: googleButtonDefault } : { postType: "update" };
  const [googleMetadata, setGoogleMetadata] = useState<GoogleBusinessPostMetadata>(initialGoogleMetadata);
  // 2026-11-10 — Feed or Story, for Instagram and for Facebook separately. Feed is preselected.
  const [instagramPlacement, setInstagramPlacement] = useState<PlacementChoice>(() => initialPlacements().instagram);
  const [facebookPlacement, setFacebookPlacement] = useState<PlacementChoice>(() => initialPlacements().facebook);

  // Roadmap Phase 7 / Task 6 — single source of truth for connection state:
  // the same read-only `GET /api/connections` the dashboard's
  // connection-health widget calls (via this shared hook). `loading` feeds
  // deriveComposerGate below, which distinguishes "still loading" from
  // "loaded and empty" and from "failed"; TikTok/YouTube no longer run their
  // own ad-hoc fetches to determine connectedness.
  const {
    connections,
    loading: connectionsLoading,
    error: connectionsError,
    reload: reloadConnections,
  } = useConnections();

  // Roadmap Phase 7 — platforms to show a live preview card for: connected
  // platforms only, in the app's standard display order.
  const connectedPlatforms = useMemo(
    () =>
      PLATFORM_ORDER.filter((platform) =>
        connections?.some((c) => c.platform === platform && c.connected),
      ),
    [connections],
  );

  // Task 7 — per-post platform targeting. `deselected` tracks platforms the
  // user has explicitly opted OUT of for this post; `selectedPlatforms`
  // derives the chosen subset from it. Starting `deselected` empty means
  // everything defaults to selected, including a platform whose connection
  // finishes loading after mount (it simply appears in `connectedPlatforms`
  // later and, having never been deselected, is selected).
  const [deselected, setDeselected] = useState<Set<Platform>>(new Set());

  // Drives the TikTok/YouTube settings gate below and the per-platform media
  // compatibility, for BOTH the upload and reuse flows: originally gated on
  // `uploadFile` alone (a real File only exists in the upload flow), so reuse
  // mode needs the equivalent signal from `reuseItem` instead. `null` until
  // some media is chosen.
  const activeMimeType = photoSet[0]?.file.type ?? uploadFile?.type ?? reuseItem?.mimeType ?? null;

  // 2026-11-01 audit: a platform whose client can't publish the chosen media
  // (YouTube/TikTok are video-only, Facebook Page images-only) is shown
  // disabled with a reason and left out of `selectedPlatforms`, so it is never
  // sent, previewed or given settings. Derived from `deselected` + the media -
  // not written into state - so picking different media restores the user's own
  // choices. See lib/postTargets.ts / PLATFORM_ACCEPTED_MEDIA.
  // Posts without a photo (2026-11-10): with nothing attached only the platforms
  // that take text alone can be chosen; attaching a file restores the rest.
  // composerPageState, with the switch read at load (TEXT_POSTS_ON); what it
  // means for the page comes from composerPageView.
  const pageState = composerPageState({
    preparingFile,
    sharedFilePending,
    reuseLoading,
    hasReuseItem: reuseItem !== null,
    hasUploadFile: uploadFile !== null,
    photoCount: photoSet.length,
    caption: uploadCaption,
    overrides: platformOverrides,
    connected: connectedPlatforms,
    deselected,
  }, TEXT_POSTS_ON);
  // Set by the first press of the submit button (platformListAlert).
  const [triedSend, setTriedSend] = useState(false);
  const pageView = useMemo(
    () =>
      composerPageView({
        pageState,
        connected: connectedPlatforms,
        deselected,
        mimeType: activeMimeType,
        mode: publishMode,
        loading: uploadLoading,
        triedSend,
      }),
    [pageState, connectedPlatforms, deselected, activeMimeType, publishMode, uploadLoading, triedSend],
  );
  const { noFile, untouched, choices: platformChoices, selected: selectedPlatforms, platformAlert, textNotice } =
    pageView;
  // Set by a press on the untouched page; it goes once there is a file or text.
  const [untouchedPressed, setUntouchedPressed] = useState(false);
  if (untouchedPressed && !untouched) setUntouchedPressed(false);
  const untouchedMessage = untouchedSubmitMessage({
    untouched,
    pressed: untouchedPressed,
    connected: connectedPlatforms,
  });
  // Only while the page is in text mode: with a file again it has nothing to say.
  const fileLostShown = noFile && fileLostNoticeShown(fileLost);
  const tiktokSelected = selectedPlatforms.includes("tiktok");
  // Why Publish is blocked for TikTok right now, or null (lib/tiktokPostRules.ts).
  const tiktokBlock = tiktokPublishBlock({
    tiktokSelected,
    blockingReason: tiktokBlockingReason,
    commercialContentEnabled: tiktokCommercialEnabled,
    metadata: tiktokMetadata,
  });
  const youtubeSelected = selectedPlatforms.includes("youtube");
  // Google's options apply to a photo post only; a video goes to the gallery.
  // A text post is always a post, so its options apply too.
  const googleOptionsShown =
    selectedPlatforms.includes("google_business_profile") &&
    (noFile || Boolean(activeMimeType?.startsWith("image/")));
  // 2026-11-10 — Feed or Story (lib/storyPlacement.ts). A second photo turns a
  // chosen Story back to Feed; it is adjusted while rendering, so no render, and
  // no request, ever has a Story with several photos (the server refuses those).
  const attachedFileCount = photoSet.length > 0 ? photoSet.length : uploadFile || reuseItem ? 1 : 0;
  const instagramChoice = reconcilePlacement(instagramPlacement, attachedFileCount);
  if (instagramChoice !== instagramPlacement) setInstagramPlacement(instagramChoice);
  const facebookChoice = reconcilePlacement(facebookPlacement, attachedFileCount);
  if (facebookChoice !== facebookPlacement) setFacebookPlacement(facebookChoice);
  // A Story needs a file: with none, a Story chosen earlier is not sent (it
  // comes back when a file is attached again).
  const instagramStory =
    !noFile && selectedPlatforms.includes("instagram") && instagramChoice.placement === "story";
  const facebookStory =
    !noFile && selectedPlatforms.includes("facebook_page") && facebookChoice.placement === "story";
  const activeVideoDurationSec = activeMimeType?.startsWith("video/") ? videoDurationSec : null;
  // Why a chosen Story cannot take this video, or null.
  const storyLengthRefusal =
    (instagramStory ? storyVideoLengthRefusal("instagram", activeVideoDurationSec) : null) ??
    (facebookStory ? storyVideoLengthRefusal("facebook_page", activeVideoDurationSec) : null);
  // Shown under the caption box while every selected platform is a Story.
  const captionStoryNote = storyOnlyCaptionNote(selectedPlatforms, [
    ...(instagramStory ? (["instagram"] as const) : []),
    ...(facebookStory ? (["facebook_page"] as const) : []),
  ]);
  // A Story repeated for weeks is rarely meant, so Repeat is off for one.
  const storyChosen = instagramStory || facebookStory;
  const repeatOn = publishMode === "schedule" && repeat !== "none" && !storyChosen;
  const repeatDates = repeatOn
    ? repeatSchedule(new Date(scheduledForLocal), repeat as RepeatInterval, repeatCount)
    : [];
  // Sent only for a selected platform with Story chosen: a feed post's request stays as it was.
  const storyRequestFields = {
    ...(instagramStory ? { instagramMetadata: { placement: "story" as const } } : {}),
    ...(facebookStory ? { facebookMetadata: { placement: "story" as const } } : {}),
  };
  // What the preview shows: what would really change the post (selected, not
  // blank, not the main caption). The request builders clean the same way.
  const previewOverrides = cleanPlatformOverrides(
    platformOverrides,
    uploadCaption,
    selectedPlatforms,
  );

  // Roadmap Phase 2 — load the reuse target, if any. Runs once per distinct
  // `reuseMediaItemId` (a fresh navigation from the media library always
  // remounts this component, so the realistic case of the param changing
  // while already mounted doesn't arise). Mirrors the MediaLibrary
  // fetch-effect convention: state starts pre-set via the `useState`
  // initializer above so nothing is set synchronously in the effect body
  // itself — every setState here happens after the `await`.
  useEffect(() => {
    if (!reuseMediaItemId) return;

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(`/api/media/${encodeURIComponent(reuseMediaItemId)}`);
        const data = (await response.json().catch(() => null)) as
          | { item?: MediaItemDto; error?: string }
          | null;

        if (cancelled) return;

        if (!response.ok || !data?.item) {
          toast.error(
            data?.error ?? "Couldn't load that media item. Upload a new file instead.",
          );
          setFileLost((current) => nextFileLostNotice(current, { type: "lost", reason: "library-failed" }));
          setReuseLoading(false);
          return;
        }

        const item = data.item;
        setReuseItem(item);
        setFileLost((current) => nextFileLostNotice(current, { type: "attached" }));
        setSingleAltText("");
        singlePhotoRef.current = item;
        setUploadCaption(item.baseCaption ?? "");
        setPlatformOverrides(
          (item.perPlatformOverrides as Partial<Record<Platform, string>> | null) ?? null,
        );
        setReuseLoading(false);
      } catch {
        if (cancelled) return;
        toast.error("Couldn't load that media item. Upload a new file instead.");
        setFileLost((current) => nextFileLostNotice(current, { type: "lost", reason: "library-failed" }));
        setReuseLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [reuseMediaItemId, toast]);

  // Build (and clean up) an object URL for the attached file so we can render
  // an inline media preview without touching the upload flow.
  // With several photos it is the cover's (the platform previews show it).
  const previewFile = photoSet[0]?.file ?? uploadFile;
  useEffect(() => {
    if (!previewFile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs derived preview state with the attached file; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
      setPreviewUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(previewFile);
    setPreviewUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [previewFile]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Clear the inline TikTok privacy validation once a level is chosen.
  useEffect(() => {
    if (tiktokMetadata.privacyLevel) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears validation once a level is chosen; pre-existing pattern newly flagged by react-hooks 7.1 (required by eslint-config-next 16.4)
      setTiktokPrivacyError(null);
    }
  }, [tiktokMetadata.privacyLevel]);

  // Scroll the success banner into view on submit — the form can be tall
  // enough that a submit from near the bottom leaves the confirmation
  // off-screen otherwise. Respects the user's reduced-motion preference.
  useEffect(() => {
    if (!showSuccess) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    successRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [showSuccess]);

  // Roadmap Phase 2 — leave reuse mode and fall back to the normal upload
  // flow. The `?mediaItemId` query param stays in the URL (harmless; the
  // fetch effect above only re-runs if that param's VALUE changes), but
  // clearing `reuseItem` is what actually drives the UI back to the file
  // input.
  const handleDismissReuse = useCallback(() => {
    setReuseItem(null);
    setSingleAltText("");
    singlePhotoRef.current = null;
    setPlatformOverrides(null);
    setUploadCaption("");
  }, []);

  // Uploads `file` to Vercel Blob at most once. Concurrent/subsequent calls
  // for the SAME file (by reference) reuse the in-flight or already-resolved
  // upload instead of starting a new one, so the attach-time auto-caption
  // path and the submit path never double-upload. If the upload fails, the
  // cache entry is cleared so a later retry with the same file can try
  // again.
  function ensureUploaded(file: File): Promise<UploadedBlobInfo> {
    if (activeUploadRef.current && activeUploadRef.current.file === file) {
      return activeUploadRef.current.promise;
    }

    const uploadKey = generateBlobKey(file);

    setUploadProgress(0);

    // Set once this upload has settled. A final progress event can be delivered
    // AFTER the promise resolves; without this it re-showed "Uploading... 100%"
    // right after the bar had been cleared (2026-11-01 audit).
    let settled = false;

    const promise = upload(uploadKey, file, {
      access: "public",
      handleUploadUrl: "/api/upload",
      // Progress feedback only; does not change upload semantics. Guarded so a
      // stale in-flight upload for a swapped-out file never moves the bar.
      onUploadProgress: (event) => {
        if (!settled && activeUploadRef.current?.file === file) {
          setUploadProgress(event.percentage);
        }
      },
    }).then(
      (newBlob) => {
        settled = true;
        const blobInfo: UploadedBlobInfo = {
          url: newBlob.url,
          filename: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
        };

        // Only commit to state if this upload is still the active one for
        // the currently selected file (the user may have swapped files
        // while this upload was in flight).
        if (activeUploadRef.current?.file === file) {
          setUploadedBlob(blobInfo);
          setUploadProgress(null);
        }

        return blobInfo;
      },
      async (err: unknown) => {
        settled = true;
        if (activeUploadRef.current?.file === file) {
          activeUploadRef.current = null;
          setUploadProgress(null);
        }
        // A full workspace storage reaches the user as its own sentence, not
        // as the blob client's generic token failure (lib/uploadFailure.ts).
        throw await explainUploadFailure(err);
      },
    );

    activeUploadRef.current = { file, promise };

    return promise;
  }

  async function runAutoCaptionFromMedia(options: {
    overwrite: boolean;
    blobOverride?: UploadedBlobInfo;
    /** The picked file, for grabbing a video's frames locally (no cross-origin canvas). */
    fileOverride?: File | null;
    /** True once the file this caption is for has been replaced by a newer pick. */
    isStale?: () => boolean;
  }) {
    const blob = options.blobOverride ?? uploadedBlob;

    if (!blob) {
      setUploadError(
        "Please upload a media file first before generating a caption.",
      );
      return;
    }

    try {
      setAutoCaptionLoading(true);
      setUploadError(null);

      // For a video, a few still frames let the AI see what it shows
      // (lib/videoFrames.ts). Grabbing them never throws: [] means the
      // caption is written without them.
      const frames = blob.mimeType.startsWith("video/")
        ? await extractVideoFrames(options.fileOverride ?? uploadFile ?? blob.url)
        : [];

      const response = await fetch("/api/posts/auto-caption", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          blobUrl: blob.url,
          mimeType: blob.mimeType,
          ...(frames.length > 0 ? { frames } : {}),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        const message =
          (errorData as { error?: string } | null)?.error ||
          "Failed to generate caption from media";
        throw new Error(message);
      }

      const data = await response.json();
      const caption = (data as { caption?: string })?.caption;

      if (typeof caption !== "string" || !caption.trim()) {
        throw new Error("AI returned an empty caption from media");
      }

      if (options.isStale?.()) {
        return;
      }

      setUploadCaption((prev) => {
        if (!options.overwrite && prev.trim()) {
          return prev;
        }
        return caption;
      });
      // Remembered even when the box kept the user's text: it then differs,
      // so "Remove all" keeps it.
      setLastAiCaption(caption);
    } catch (err: unknown) {
      console.error("Error generating caption from media:", err);
      if (!options.isStale?.()) {
        toast.error((err as Error).message || "Failed to generate caption from media");
      }
    } finally {
      // A replaced pick leaves the busy state to the newer one.
      if (!options.isStale?.()) {
        setAutoCaptionLoading(false);
      }
    }
  }

  // The one way a file gets attached: picked in the file input, or shared to
  // the installed app on Android (the effect below). Null clears the pick.
  async function attachPickedFile(pickedFile: File | null) {
    const selection = ++fileSelectionRef.current;
    setPreparingPick((current) =>
      nextPreparingPick(current, pickedFile ? { type: "pick", selection } : { type: "clear" }),
    );
    // Clearing the pick is the person's own doing (or the form's reset): no
    // "file went away" notice is left over from before. A pick that then fails
    // sets it again below.
    if (!pickedFile) setFileLost((current) => nextFileLostNotice(current, { type: "reset" }));
    // A new pick (or none) replaces any attached photos too.
    changePhotoSet((prev) => (prev.length === 0 ? prev : []));
    setUploadFile(null);
    setVideoDurationSec(null);
    setUploadedBlob(null);
    // A description belongs to its photo: a new pick starts without one.
    setSingleAltText("");
    singlePhotoRef.current = null;
    setShowSuccess(false);
    // Changing (or clearing) the file invalidates any
    // in-flight/completed upload for the previous file so it
    // can never be applied to this new selection.
    activeUploadRef.current = null;

    if (!pickedFile) {
      // A cleared input ends any busy state an earlier pick left.
      setAutoCaptionLoading(false);
      return;
    }

    try {
      setAutoCaptionLoading(true);
      setUploadError(null);

      // iPhone HEIC -> JPEG, big photos shrunk, unsupported
      // types refused with a clear message (prepareUploadFile.ts).
      let nextFile: File;
      try {
        nextFile = await prepareUploadFile(pickedFile);
      } catch (prepareError) {
        setPreparingPick((current) => nextPreparingPick(current, { type: "settled", selection }));
        if (selection === fileSelectionRef.current) {
          // Clear the input so the same file can be picked again.
          setFileInputKey((key) => key + 1);
          setFileLost((current) => nextFileLostNotice(current, { type: "lost", reason: "prepare-failed" }));
        }
        throw prepareError;
      }
      setPreparingPick((current) => nextPreparingPick(current, { type: "settled", selection }));
      if (selection !== fileSelectionRef.current) {
        return;
      }
      setUploadFile(nextFile);
      setFileLost((current) => nextFileLostNotice(current, { type: "attached" }));
      singlePhotoRef.current = nextFile;

      const blobInfo = await ensureUploaded(nextFile);
      // A newer pick replaced this one while it uploaded: its
      // caption must not land on the newer photo.
      const isStale = () => selection !== fileSelectionRef.current;
      if (isStale()) {
        return;
      }

      if (autoCaptionEnabled) {
        await runAutoCaptionFromMedia({
          overwrite: false,
          blobOverride: blobInfo,
          fileOverride: nextFile,
          isStale,
        });
      }
    } catch (err: unknown) {
      console.error(
        "Error uploading media for auto-caption:",
        err,
      );
      // A newer pick has replaced this one: its error is moot.
      if (selection === fileSelectionRef.current) {
        toast.error(
          (err as Error).message ||
            "Failed to prepare media for posting. Please try again.",
        );
      }
    } finally {
      // Only the latest pick owns the busy state.
      if (selection === fileSelectionRef.current) {
        setAutoCaptionLoading(false);
      }
    }
  }

  // 07c: one photo of a set, uploaded the way ensureUploaded uploads a single
  // file (same key, route and storage-full sentence) but without its
  // one-file state, which the single path keeps for itself.
  async function uploadPhoto(file: File, onProgress: (percent: number) => void): Promise<UploadedBlobInfo> {
    let settled = false;
    try {
      const newBlob = await upload(generateBlobKey(file), file, {
        access: "public",
        handleUploadUrl: "/api/upload",
        onUploadProgress: (event) => {
          if (!settled) onProgress(event.percentage);
        },
      });
      return { url: newBlob.url, filename: file.name, mimeType: file.type, sizeBytes: file.size };
    } catch (err: unknown) {
      throw await explainUploadFailure(err);
    } finally {
      settled = true;
    }
  }

  // 07d: "Write it for me" for the single photo. The answer goes to that photo
  // wherever it is now: still the single photo (returned, for the field), moved
  // into the set by "Add photos" (written onto its place there), or gone (dropped).
  async function describeSinglePhoto(blob: UploadedBlobInfo, photo: object): Promise<string | null> {
    const text = await requestPhotoDescription(blob);
    const target = whereDescriptionGoes(photo, { single: singlePhotoRef.current, set: photoSetRef.current });
    if (target?.to === "set") {
      changePhotoSet((prev) => patchPhoto(prev, target.key, { altText: text }));
      return null;
    }
    return target?.to === "single" ? text : null;
  }

  const isPhotoAttached = (key: string) => photoSetRef.current.some((photo) => photo.key === key);
  const isCoverPhoto = (key: string) => photoSetRef.current[0]?.key === key;

  // Queue photos for upload behind any already uploading. With `wantCaption`
  // (a fresh pick), the AI caption is written once, from the first of them to
  // finish while it is the cover, and dropped if it stops being the cover.
  function queuePhotoUploads(
    entries: { key: string; file: File }[],
    isStale: () => boolean,
    wantCaption: boolean,
  ) {
    const writeCaption = wantCaption && autoCaptionEnabled;
    photoQueueRef.current = photoQueueRef.current.then(() =>
      uploadPhotosInOrder(entries, {
        upload: uploadPhoto,
        isStale,
        isAttached: isPhotoAttached,
        isCover: isCoverPhoto,
        onUpdate: (key, patch) => changePhotoSet((prev) => patchPhoto(prev, key, patch)),
        onCaption: writeCaption
          ? (key, blob, file) => {
              void runAutoCaptionFromMedia({
                overwrite: false,
                blobOverride: blob,
                fileOverride: file,
                isStale: () => isStale() || !isCoverPhoto(key),
              }).finally(() => {
                if (!isStale()) setAutoCaptionLoading(false);
              });
            }
          : undefined,
        onDone: (captionStarted) => {
          if (writeCaption && !captionStarted) setAutoCaptionLoading(false);
        },
      }),
    );
  }

  // 07c: several photos picked at once in the main input (`replace`: it
  // replaces what is attached; only shown with fewer than two photos) or
  // added with "Add photos". A pick that breaks a rule attaches nothing and
  // says why (lib/postMedia.ts).
  async function attachPickedPhotos(picked: File[], replace: boolean) {
    const attachedCount = replace ? 0 : Math.max(photoSetRef.current.length, 1);
    // An iPhone photo counts as the JPEG it becomes; checked again after.
    const problem = photoPickProblem(
      attachedCount,
      picked.map((file) => ({ type: isHeicFile(file) ? "image/jpeg" : file.type })),
    );
    if (problem) {
      setUploadError(problem);
      if (replace) setFileInputKey((key) => key + 1);
      return;
    }

    if (replace) {
      void attachPickedFile(null);
      setUploadProgress(null);
    }
    const selection = fileSelectionRef.current;
    const isStale = () => selection !== fileSelectionRef.current || !mountedRef.current;
    const nextKey = () => `photo-${++photoKeyRef.current}`;
    // Adding to a single attached photo: it moves into the set, first.
    const first: AttachedPhoto[] =
      !replace && photoSetRef.current.length === 0 && uploadFile && uploadedBlob
        ? [
            {
              key: nextKey(),
              file: uploadFile,
              status: "uploaded",
              progress: 0,
              blob: uploadedBlob,
              error: null,
              // Its description goes with it into the set.
              altText: singleAltText,
            },
          ]
        : [];
    if (first.length > 0) {
      setUploadFile(null);
      setUploadedBlob(null);
      setSingleAltText("");
      singlePhotoRef.current = null;
    }
    // Shown at once, marked "Preparing", while HEIC photos convert.
    const placeholders: AttachedPhoto[] = picked.map((file) => ({
      key: nextKey(),
      file,
      status: "preparing",
      progress: 0,
      blob: null,
      error: null,
    }));
    const pickKeys = new Set(placeholders.map((photo) => photo.key));
    changePhotoSet((prev) => addPhotos(prev.length > 0 ? prev : first, placeholders));
    setUploadError(null);
    setShowSuccess(false);
    setPreparingPhotos(true);
    if (replace && autoCaptionEnabled) setAutoCaptionLoading(true);

    try {
      const prepared = await preparePhotos(placeholders, {
        prepare: (file) => prepareUploadFile(file),
        isStale,
        isAttached: isPhotoAttached,
      });
      if (!prepared) return;

      const typeProblem = photoPickProblem(attachedCount, prepared.map((entry) => entry.file));
      if (typeProblem) throw new Error(typeProblem);

      for (const { key, file } of prepared) {
        changePhotoSet((prev) => patchPhoto(prev, key, { file, status: "waiting" }));
      }
      setFileLost((current) => nextFileLostNotice(current, { type: "attached" }));
      queuePhotoUploads(prepared, isStale, replace);
    } catch (err: unknown) {
      if (isStale()) return;
      // Attach nothing from this pick.
      changePhotoSet((prev) => prev.filter((photo) => !pickKeys.has(photo.key)));
      setUploadError((err as Error).message || "Failed to prepare media for posting. Please try again.");
      if (photosFailureLosesFile({ attachedBefore: attachedCount })) {
        setFileLost((current) => nextFileLostNotice(current, { type: "lost", reason: "photos-failed" }));
      }
      if (replace) {
        setFileInputKey((key) => key + 1);
        setAutoCaptionLoading(false);
      }
    } finally {
      setPreparingPhotos(false);
    }
  }

  // Back to an empty picker: the last photo removed, or "Remove all".
  function clearAttachedPhotos() {
    void attachPickedFile(null);
    setFileInputKey((k) => k + 1);
  }

  // "Remove all": a caption the AI wrote for these photos, still unedited,
  // goes with them so the next photos get their own. Per-platform captions stay.
  const removeAllClearsTheCaption = removeAllClearsCaption(uploadCaption, lastAiCaption);
  function removeAllPhotos() {
    if (removeAllClearsTheCaption) {
      setUploadCaption("");
      setLastAiCaption(null);
    }
    setUploadError(null);
    clearAttachedPhotos();
  }

  function removeAttachedPhoto(key: string) {
    const current = photoSetRef.current;
    if (current.length === 1 && current[0].key === key) {
      // The caption the AI wrote for it goes too, as "Remove all" does: it
      // would otherwise go out as a text post.
      if (lastPhotoRemovalClearsCaption({ remaining: 0, caption: uploadCaption, lastAiCaption })) {
        setUploadCaption("");
        setLastAiCaption(null);
      }
      clearAttachedPhotos();
      return;
    }
    changePhotoSet((prev) => removePhoto(prev, key));
  }

  function retryAttachedPhoto(key: string) {
    const photo = photoSetRef.current.find((p) => p.key === key);
    if (!photo || photo.status !== "failed") return;
    const selection = fileSelectionRef.current;
    changePhotoSet((prev) => patchPhoto(prev, key, { status: "waiting", error: null }));
    queuePhotoUploads(
      [{ key, file: photo.file }],
      () => selection !== fileSelectionRef.current || !mountedRef.current,
      false,
    );
  }

  // What to render while connections load, resolve, or fail — pure rule in
  // lib/composerGate.ts. Computed here, above the shared-file effect that
  // waits for it; the early returns that use it are further down.
  const composerGate = deriveComposerGate(connections, connectionsLoading);

  // Android share target: public/sw.js parked the shared file in Cache Storage
  // and sent the user here with ?shared=1. It is taken only once the form
  // shows (lib/sharedFile.ts shouldTakeSharedFile), for the same reason the
  // file input waits for it (see the gate comment near the early returns).
  // The ref makes it one take per mount even if the gate changes mid-take.
  // Not cancelled on unmount on purpose: the take empties the cache, so a
  // dropped result would lose the file (React's dev double-mount would do
  // exactly that).
  const attachSharedFile = useEffectEvent((file: File) => {
    void attachPickedFile(file);
  });
  const sharedParam = searchParams.get("shared");
  const sharedTakenRef = useRef(false);
  useEffect(() => {
    if (!shouldTakeSharedFile(sharedParam, composerGate) || sharedTakenRef.current) return;
    sharedTakenRef.current = true;
    void (async () => {
      const file = await takeSharedFile();
      // Arrived (now a pick being prepared, in the same render) or found nothing.
      setSharedSettled(true);
      if (!file) return;
      attachSharedFile(file);
      const url = new URL(window.location.href);
      url.searchParams.delete("shared");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    })();
  }, [sharedParam, composerGate]);

  useEffect(() => {
    if (publishMode !== "schedule" || slotData !== null) return;
    let cancelled = false;
    fetch("/api/posts/scheduled-times")
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("not ok"))))
      .then((body: { times?: string[]; slots?: PostingSlot[] }) => {
        if (cancelled) return;
        setSlotData({ slots: body.slots ?? [], taken: (body.times ?? []).map((time) => new Date(time)) });
      })
      .catch(() => {
        if (!cancelled) setSlotData("error");
      });
    return () => {
      cancelled = true;
    };
  }, [publishMode, slotData]);

  function fillNextFreeSlot() {
    if (!slotData || slotData === "error") return;
    const presses = slotPresses + 1;
    const next = nextFreeSlots(slotData.slots, slotData.taken, new Date(), presses)[presses - 1];
    if (!next) {
      toast.error("No free posting time was found. Pick a date and time by hand.");
      return;
    }
    setScheduledForLocal(toDateTimeLocalValue(next));
    setSlotPresses(presses);
  }

  // Extracted from handleUploadSubmit below (Task 7 / Step 5) so it can run
  // either directly (schedule/draft — no confirmation needed) or via the
  // publish-now confirmation dialog's onConfirm (immediate publish). Every
  // blocking validation (file/caption/platforms/schedule/tiktok privacy)
  // already ran in handleUploadSubmit before either path reaches here, so
  // this only builds the request and submits it. Handles its own
  // loading/toast/error state and never throws — ConfirmDialog always closes
  // after this resolves; failures surface via toast, same as before this task.
  async function performSubmit() {
    setUploadLoading(true);

    // Deferred (schedule/draft) jobs persist tiktok/youtube metadata on the
    // job (PostJob.publishMetadata) and replay it at publish — see
    // server/jobs/posting.ts. The schedule time was already validated in
    // handleUploadSubmit before it called (or deferred calling) this
    // function, so re-deriving it here from the same unchanged state is safe.
    const deferred: DeferredPostFields = {};
    if (publishMode === "draft") {
      deferred.draft = true;
    } else if (publishMode === "schedule") {
      const iso = localDateTimeToUtcIso(scheduledForLocal);
      if (iso) {
        deferred.scheduledFor = iso;
      }
    }

    const photoDescriptions = reuseItem
      ? reuseItem.mimeType.startsWith("image/")
        ? [singleAltText]
        : []
      : photoSet.length > 0
        ? photoSet.map((photo) => photo.altText)
        : uploadFile?.type.startsWith("image/")
          ? [singleAltText]
          : [];

    try {
      let postData: CreatePostRequest | CreatePostReuseRequest | CreatePostMediaRequest | CreateTextPostRequest;

      if (noFile) {
        // A post without a photo: no upload, no file fields.
        postData = buildTextPostBody({
          baseCaption: uploadCaption,
          platforms: selectedPlatforms,
          deferred,
          workspaceId,
          perPlatformOverrides: platformOverrides,
          googleMetadata: googleOptionsShown ? googleMetadata : undefined,
        });
      } else if (reuseItem) {
        // Roadmap Phase 2 — reuse: no upload, attach the existing MediaItem.
        postData = buildReusePostBody({
          mediaItemId: reuseItem.id,
          baseCaption: uploadCaption,
          location: uploadLocation,
          // Task 7 — chosen platform subset for this post.
          platforms: selectedPlatforms,
          deferred,
          workspaceId,
          // Cleaned by the builder, the same way as for the preview.
          perPlatformOverrides: platformOverrides,
          // Task 7 — only attach metadata for a platform still selected for
          // this post; a deselected TikTok/YouTube isn't published to.
          tiktokMetadata: tiktokSelected ? tiktokMetadata : undefined,
          youtubeMetadata: youtubeSelected ? youtubeMetadata : undefined,
          googleMetadata: googleOptionsShown ? googleMetadata : undefined,
        });
      } else if (photoSet.length > 0) {
        // 07c: the attached photos in the order shown (handleUploadSubmit
        // checked every one is uploaded). One left gives today's body.
        postData = buildPhotosPostBody({
          blobs: photoSet.flatMap((photo) => (photo.blob ? [photo.blob] : [])),
          baseCaption: uploadCaption,
          location: uploadLocation,
          platforms: selectedPlatforms,
          deferred,
          workspaceId,
          perPlatformOverrides: platformOverrides,
          tiktokMetadata: tiktokSelected ? tiktokMetadata : undefined,
          youtubeMetadata: youtubeSelected ? youtubeMetadata : undefined,
          googleMetadata: googleOptionsShown ? googleMetadata : undefined,
        });
      } else {
        // Unreachable given the guard in handleUploadSubmit (this branch only
        // runs when reuseItem is falsy, and that guard already required
        // reuseItem || uploadFile), but narrows `uploadFile` to `File` for
        // TypeScript without a non-null assertion.
        if (!uploadFile) {
          setUploadError("Please choose a file to upload.");
          setUploadLoading(false);
          return;
        }

        // Reuses the attach-time upload when it already covers this exact
        // file; only uploads if it hasn't been (or needs to be re-) uploaded.
        const blob = await ensureUploaded(uploadFile);

        postData = buildUploadPostBody({
          blob,
          baseCaption: uploadCaption,
          location: uploadLocation,
          // Task 7 — chosen platform subset for this post.
          platforms: selectedPlatforms,
          deferred,
          workspaceId,
          // Cleaned by the builder, the same way as for the preview.
          perPlatformOverrides: platformOverrides,
          // Task 7 — only attach metadata for a platform still selected for
          // this post; a deselected TikTok/YouTube isn't published to.
          tiktokMetadata: tiktokSelected ? tiktokMetadata : undefined,
          youtubeMetadata: youtubeSelected ? youtubeMetadata : undefined,
          googleMetadata: googleOptionsShown ? googleMetadata : undefined,
        });
      }

      // 07d: each photo's description beside its file; a video takes none. On
      // a reused photo an empty field sends none, so it keeps the one it has.
      postData = withPhotoDescriptions(postData, photoDescriptions);

      // Repeat: the dates after the first; the first is `scheduledFor`.
      const repeatFields =
        repeatOn && repeatDates.length >= REPEAT_MIN_COUNT
          ? { repeatAt: repeatDates.slice(1).map((date) => date.toISOString()) }
          : {};

      const response = await fetch("/api/posts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...postData, ...storyRequestFields, ...repeatFields }),
      });

      const data: unknown = await response.json().catch(() => null);

      // Response → what the composer does (lib/composerSubmitOutcome.ts).
      const outcome = composerSubmitOutcome({ ok: response.ok, body: data, mode: publishMode });
      // A series says how many posts it made ("4 posts scheduled.").
      const seriesMessage =
        "repeatAt" in repeatFields && outcome.kind === "success"
          ? (data as { message?: unknown } | null)?.message
          : null;

      // Nothing was created: keep the form so the user can fix and resend.
      if (!outcome.resetForm) {
        // A refused series names the date in the viewer's own zone.
        const localRefusal =
          "repeatAt" in repeatFields
            ? repeatRefusalText(data, (date) =>
                date.toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                }),
              )
            : null;
        toast.error(localRefusal ?? outcome.toast);
        // 2026-11-01 audit (M3): the workspace was switched in another tab, so
        // pressing Post again can only 409 again until the page is reloaded.
        // A toast fades; pin the server's message in the form's error banner.
        // The form itself is left exactly as it is (file, caption, platforms).
        if (outcome.kind === "workspace_changed") {
          setUploadError(outcome.toast);
        }
        setUploadLoading(false);
        return;
      }

      // The post exists — created, or (DISPATCH_FAILED, final review M3) saved
      // but its publishing never started, so it already sits `failed` in
      // Activity. Either way the form resets: pressing Post again would create
      // a second job, and retrying the first later would publish it twice.
      if (outcome.kind === "dispatch_failed") {
        toast.error(outcome.toast);
      } else {
        toast.success(typeof seriesMessage === "string" && seriesMessage ? seriesMessage : outcome.toast);
      }
      setDispatchFailed(outcome.kind === "dispatch_failed");
      setAwaitingApproval(outcome.kind === "success" && outcome.heldForApproval);
      setSubmittedMode(publishMode);
      setSubmittedToTikTok(tiktokSelected);
      setShowSuccess(true);
      setUploadCaption("");
      setUploadLocation("");
      // A new post has not been tried yet (platformListAlert).
      setTriedSend(false);
      // Nor has it lost a file: an old notice must not show on the next post.
      setFileLost((current) => nextFileLostNotice(current, { type: "reset" }));
      // Detach the media once the post is saved. For the reuse path this
      // prevents an accidental second submit from re-posting the same item;
      // for the upload path it clears the file state as before. Clearing
      // `reuseItem` returns the composer to the normal file-upload UI.
      setUploadFile(null);
      setUploadedBlob(null);
      setSingleAltText("");
      singlePhotoRef.current = null;
      changePhotoSet(() => []);
      activeUploadRef.current = null;
      // Clear the finished upload's bar and remount the file input, so the old
      // filename is gone and choosing the same file again fires a change event.
      setUploadProgress(null);
      setFileInputKey((key) => key + 1);
      setReuseItem(null);
      setPlatformOverrides(null);
      setPublishMode("now");
      setScheduledForLocal("");
      setRepeat("none");
      setRepeatCount(REPEAT_DEFAULT_COUNT);
      setSlotPresses(0);
      // Read the taken times again next time: this post holds one now.
      setSlotData(null);
      // Task 7 — every connected platform defaults back to selected for the
      // next post.
      setDeselected(new Set());
      setTiktokMetadata({
        privacyLevel: "",
        disableComment: true,
        disableDuet: true,
        disableStitch: true,
      });
      setTiktokCommercialEnabled(false);
      setYoutubeMetadata({ privacyStatus: "unlisted" });
      setGoogleMetadata(initialGoogleMetadata());
      // A Story never carries over to the next post: both go back to Feed.
      const startPlacements = initialPlacements();
      setInstagramPlacement(startPlacements.instagram);
      setFacebookPlacement(startPlacements.facebook);
      setUploadLoading(false);
    } catch (err: unknown) {
      // An upload refused for full storage says so; anything else stays generic.
      toast.error(
        err instanceof UploadRefusedError ? err.message : "Unexpected error while creating post.",
      );
      setUploadLoading(false);
    }
  }

  async function handleUploadSubmit(event: React.FormEvent) {
    event.preventDefault();
    // The order of these first checks is submitFirstStep's.
    const first = submitFirstStep({
      pageState,
      fileLost: fileLostShown ? fileLost : "none",
      fileBlock:
        preparingFile || sharedPendingNow
          ? fileSubmitBlock({
              preparingFile,
              sharedFilePending: sharedPendingNow,
              preparingPhotos: false,
              photosNotReady: false,
            })
          : null,
    });
    if (first.countsAsTry) setTriedSend(true);
    // A file just went away: the first press stops here, with the notice (and
    // any error beside it) still showing, so the person sees it before a dialog.
    if (fileLostShown) setFileLost((current) => nextFileLostNotice(current, { type: "pressed" }));
    if (first.stop === "file-lost") {
      // The press did nothing else, so say why.
      toast.error("Nothing was sent. The photo or video could not be added: see the notice above the buttons.");
      return;
    }
    setUploadError(null);
    setShowSuccess(false);

    if (first.stop === "wait") {
      setUploadError(first.message);
      return;
    }

    // Nothing to send yet: say so by the button (untouchedSubmitMessage).
    if (first.stop === "untouched") {
      setUntouchedPressed(true);
      return;
    }

    if (noFile) {
      const textError = noFileSubmitError({
        caption: uploadCaption,
        selectedCount: selectedPlatforms.length,
        allDisabled: platformChoices.every((choice) => choice.disabledReason !== null),
      });
      if (textError) {
        setUploadError(textError);
        return;
      }
    } else if (!reuseItem && !uploadFile && photoSet.length === 0) {
      setUploadError("Please choose a file to upload.");
      return;
    }

    if (photoSet.length > 0 && !photoSetReady(photoSet)) {
      setUploadError("Wait until every photo has uploaded, or remove the ones that failed.");
      return;
    }

    if (!uploadCaption.trim()) {
      setUploadError("Please enter a caption for this post.");
      return;
    }

    // 2026-11-01 scale audit (jobs, event size): POST /api/posts 400s a caption over the
    // cap; the submit button is already disabled, this covers any other path.
    if (captionOver) {
      setUploadError(captionTooLongMessage("Caption"));
      return;
    }

    // Task 7 — at least one target platform must stay selected.
    if (selectedPlatforms.length === 0) {
      setUploadError(
        platformChoices.every((choice) => choice.disabledReason !== null)
          ? "None of your connected platforms can publish this media. Choose a different file."
          : "Select at least one platform to publish to.",
      );
      return;
    }

    const tiktokCommercialBlocked =
      tiktokSelected &&
      tiktokCommercialEnabled &&
      !tiktokMetadata.brandedContent &&
      !tiktokMetadata.brandOrganic;
    if (tiktokCommercialBlocked) {
      setUploadError(TIKTOK_DISCLOSURE_INCOMPLETE_TEXT);
      return;
    }

    if (storyLengthRefusal) {
      setUploadError(storyLengthRefusal);
      return;
    }

    if (publishMode === "schedule") {
      const iso = localDateTimeToUtcIso(scheduledForLocal);
      if (!iso) {
        setUploadError("Please choose a valid date and time to schedule this post.");
        return;
      }
      if (new Date(iso).getTime() < Date.now() + SCHEDULE_BUFFER_MS) {
        setUploadError("Scheduled time must be at least a minute in the future.");
        return;
      }
      if (repeatOn && repeatDates.length < REPEAT_MIN_COUNT) {
        setUploadError("Choose how many times the post repeats, then press the button again.");
        return;
      }
    }

    // Ruling R5 (2026-11-01 audit): a TikTok privacy level is required whenever
    // TikTok is a SELECTED target, for EVERY intent. It used to be asked for only
    // on "Publish now", so a scheduled or draft TikTok post silently went out
    // as SELF_ONLY. A deselected (or media-incompatible) TikTok isn't published
    // to, so it needs none. POST /api/posts enforces the same rule. Runs BEFORE
    // the publish-now confirmation dialog below so the dialog only ever opens
    // on an already-valid form.
    if (isTikTokPrivacyMissing(selectedPlatforms, tiktokMetadata)) {
      setTiktokPrivacyError(TIKTOK_PRIVACY_REQUIRED_MESSAGE);
      toast.error(TIKTOK_PRIVACY_REQUIRED_MESSAGE);
      return;
    }

    // Immediate publishes can't be undone once sent — confirm first. A text post
    // is also confirmed when scheduled; a draft and a scheduled post with a file
    // submit directly, as before.
    if (needsSubmitConfirm({ mode: publishMode, noFile })) {
      setConfirmPublishOpen(true);
      return;
    }
    await performSubmit();
  }

  async function handleEnhanceCaption() {
    if (!uploadCaption.trim()) {
      setUploadError("Please enter some text first to enhance.");
      return;
    }

    try {
      setEnhancingCaption(true);
      setUploadError(null);

      const response = await fetch("/api/posts/enhance-caption", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          caption: uploadCaption,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to enhance caption");
      }

      const data = await response.json();
      const enhancedCaption = data.enhancedCaption;

      // Set the enhanced caption in the textarea
      setUploadCaption(enhancedCaption);
    } catch (err: unknown) {
      console.error("Error enhancing caption:", err);
      toast.error((err as Error).message || "Failed to enhance caption");
    } finally {
      setEnhancingCaption(false);
    }
  }

  const isImagePreview = uploadFile?.type.startsWith("image/") ?? false;
  const isVideoPreview = uploadFile?.type.startsWith("video/") ?? false;

  // Roadmap Phase 7 — same media the sections above already preview, reused
  // (never re-uploaded) for the per-platform preview cards: the reused
  // MediaItem's public blob URL in reuse mode, else the local object-URL
  // preview of the freshly attached file.
  const activeMediaUrl = reuseItem ? reuseItem.storageLocation : previewUrl;

  // `composerGate` (computed above the hooks that need it). The `loading`
  // branch exists because rendering the full form during the first fetch let
  // the user attach a file (the blob upload even ran) that the
  // zero-connection CTA below then silently discarded when the fetch
  // resolved. Both early returns sit after every hook, so hook order is
  // unaffected.
  if (composerGate === "loading") {
    // Same placeholder the Suspense boundary below shows, so first paint and
    // connections-loading are visually indistinguishable.
    return <CreatePostFormSkeleton />;
  }

  // The connections request failed (2026-11-01 audit). The form can't help
  // here: with no platforms known it would render empty and every submit would
  // fail "Select at least one platform". Say what happened and let the user
  // retry; a retry flips the gate back to the loading skeleton.
  if (composerGate === "error") {
    return (
      <Card className="p-6">
        <Alert variant="danger" title="Couldn't load your connections">
          <div className="flex flex-col items-start gap-3">
            <p>
              {connectionsError ?? "Failed to load connections."} We need them to know which
              platforms you can post to.
            </p>
            <Button size="sm" variant="outline" onClick={reloadConnections}>
              Retry
            </Button>
          </div>
        </Alert>
      </Card>
    );
  }

  // With nothing connected there is no submit path at all — publish, schedule
  // and save-draft are each disabled — so rendering the form underneath the
  // connect CTA only invites the user to fill in a post that can never go
  // anywhere. Show the CTA on its own instead. It also covers the reuse flow
  // (arriving from Media -> "Use in new post"), where posting is equally
  // impossible.
  if (composerGate === "connect") {
    return (
      <Card className="p-6">
        <EmptyState
          icon={<PlugZap />}
          title="Connect a platform to start posting"
          description="Vibe Socials publishes to the platforms you've connected. Connect at least one in Settings, then come back here."
          action={
            <Link href={SETTINGS_CONNECTIONS_HREF} className={buttonVariants({ variant: "primary" })}>
              Go to connections
            </Link>
          }
        />
      </Card>
    );
  }

  // Publish-now confirmation copy — a held member's post is submitted for
  // review, not published (lib/composerConfirm.ts).
  const confirmCopy: ComposerConfirmCopy & { notice?: string | null } =
    noFile && publishMode !== "draft"
      ? textPostConfirmCopy({
          mode: publishMode,
          holdsForApproval,
          platforms: selectedPlatforms.map(platformLabel),
          notice: textNotice,
          whenText: scheduleWhenText(scheduledForLocal),
          // The chosen count (a plain number): reading `repeatDates` here trips the
          // compiler's purity check on the submit handler's Date.now().
          repeatCount: repeatOn ? repeatCount : undefined,
        })
      : composerPublishConfirmCopy({
          holdsForApproval,
          platforms: selectedPlatforms.map(platformLabel),
        });

  // Read by the form's button and the phone's publish bar alike.
  const control = submitControl({
    buttonLabel: pageView.buttonLabel,
    loading: uploadLoading,
    // The text itself, not captionOver: passing that made the React compiler
    // skip this component (lint).
    caption: uploadCaption,
    tiktokBlock,
    fileBlock: fileSubmitBlock({
      preparingFile,
      sharedFilePending: sharedPendingNow,
      preparingPhotos,
      photosNotReady: photoSet.length > 0 && !photoSetReady(photoSet),
    }),
    untouchedMessage,
    platformAlert,
  });

  return (
    <>
    <Card className="p-6">
      <form id="create-post-form" onSubmit={handleUploadSubmit} className="space-y-5">
        {showSuccess && dispatchFailed && (
          <div ref={successRef}>
            <Alert variant="warning" title="Publishing didn't start">
              <div className="flex flex-col items-start gap-2">
                <p>{COMPOSER_DISPATCH_FAILED_MESSAGE}</p>
                <Link
                  href="/activity"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  View activity
                </Link>
              </div>
            </Alert>
          </div>
        )}

        {showSuccess && !dispatchFailed && (
          <div ref={successRef}>
            <Alert
              variant="success"
              title={
                awaitingApproval
                  ? "Sent for approval"
                  : submittedMode === "draft"
                    ? "Draft saved"
                    : submittedMode === "schedule"
                      ? "Post scheduled"
                      : "Post queued"
              }
            >
              <div className="flex flex-col items-start gap-2">
                <p>
                  {awaitingApproval
                    ? "An owner will review it before anything publishes. You can follow its status in the Queue."
                    : submittedMode === "draft"
                      ? "Your draft is saved. Publish or schedule it any time from the Queue."
                      : submittedMode === "schedule"
                        ? "We'll publish this at the time you chose. Edit or cancel it from the Queue until then."
                        : "We're publishing to your connected platforms. Per-platform results appear in Activity."}
                </p>
                {submittedToTikTok && submittedMode !== "draft" && !awaitingApproval ? (
                  <p>
                    TikTok: after publishing, it may take a few minutes for your video to process and
                    be visible on your profile.
                  </p>
                ) : null}
                <Link
                  href={!awaitingApproval && submittedMode === "now" ? "/activity" : "/queue"}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {!awaitingApproval && submittedMode === "now"
                    ? "View activity"
                    : "View queue"}
                </Link>
              </div>
            </Alert>
          </div>
        )}

        {uploadError && <Alert variant="danger">{uploadError}</Alert>}

        <div className="space-y-1.5">
          {reuseItem ? (
            // Roadmap Phase 2 — reuse mode: preview the already-persisted
            // MediaItem from its storageLocation and skip the upload UI
            // entirely (no `id="post-media"` control exists in this branch,
            // so this uses a plain label-styled <p>, not <Label htmlFor>).
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">Media</p>
                <button
                  type="button"
                  onClick={handleDismissReuse}
                  className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  Use a different file instead
                </button>
              </div>
              {reuseItem.mimeType.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element -- remote (already-public) Vercel Blob URL preview; same bounded-size pattern as the local object-URL preview below
                <img
                  src={reuseItem.storageLocation}
                  alt={`Preview of ${reuseItem.originalFilename}`}
                  className="max-h-64 w-auto rounded-[var(--radius)] border border-border object-contain"
                />
              ) : reuseItem.mimeType.startsWith("video/") ? (
                <video
                  src={reuseItem.storageLocation}
                  controls
                  onLoadedMetadata={(e) => setVideoDurationSec(e.currentTarget.duration)}
                  className="max-h-64 w-full rounded-[var(--radius)] border border-border"
                />
              ) : null}
              <p className="text-xs text-muted-foreground">
                {reuseItem.originalFilename} &middot; {formatBytes(reuseItem.sizeBytes)}
              </p>
              {reuseItem.mimeType.startsWith("image/") && (
                <PhotoDescriptionField
                  id="post-alt-text"
                  label="Describe this photo (alt text)"
                  value={singleAltText}
                  onChange={setSingleAltText}
                  onWrite={() =>
                    describeSinglePhoto(
                      {
                        url: reuseItem.storageLocation,
                        filename: reuseItem.originalFilename,
                        mimeType: reuseItem.mimeType,
                        sizeBytes: reuseItem.sizeBytes,
                      },
                      reuseItem,
                    )
                  }
                />
              )}
            </div>
          ) : reuseLoading ? (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-48 w-full max-w-sm" />
            </div>
          ) : (
            <>
              {/* 07c: with two or more photos the main input is hidden, so a
                  pick there can't silently replace the set; "Add photos" and
                  "Remove all" take its place. */}
              {photoSet.length < 2 ? (
                <>
                  <Label htmlFor="post-media">Media file (image or video)</Label>
                  <Input
                    key={fileInputKey}
                    id="post-media"
                    type="file"
                    accept="video/*,image/*"
                    multiple
                    disabled={preparingPhotos}
                    onChange={(event) => {
                      // One file (or none) takes today's path unchanged.
                      const files = Array.from(event.target.files ?? []);
                      if (files.length > 1) void attachPickedPhotos(files, true);
                      else void attachPickedFile(files[0] ?? null);
                    }}
                    className="cursor-pointer"
                  />
                  {noFile ? (
                    <p className="text-xs text-muted-foreground">
                      Optional: without a file the post is text only, for Facebook, X, LinkedIn and Google.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-sm font-medium text-foreground">Photos</p>
              )}

              {photoSet.length > 0 && (
                <AttachedPhotos
                  photos={photoSet}
                  onRemove={removeAttachedPhoto}
                  onMove={(key, direction) => changePhotoSet((prev) => movePhoto(prev, key, direction))}
                  onRetry={retryAttachedPhoto}
                  onRemoveAll={removeAllPhotos}
                  removeAllClearsCaption={removeAllClearsTheCaption}
                  onDescribe={(key, text) => changePhotoSet((prev) => patchPhoto(prev, key, { altText: text }))}
                />
              )}

              {photoSet.length === 0 && uploadFile && previewUrl && (
                <div className="mt-2 space-y-2">
                  {isImagePreview ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local object-URL preview; next/image would need remote host config
                    <img
                      src={previewUrl}
                      alt={`Preview of ${uploadFile.name}`}
                      className="max-h-64 w-auto rounded-[var(--radius)] border border-border object-contain"
                    />
                  ) : isVideoPreview ? (
                    <video
                      src={previewUrl}
                      controls
                      onLoadedMetadata={(e) => setVideoDurationSec(e.currentTarget.duration)}
                      className="max-h-64 w-full rounded-[var(--radius)] border border-border"
                    />
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {uploadFile.name} &middot; {formatBytes(uploadFile.size)}
                  </p>
                  {isImagePreview && (
                    <PhotoDescriptionField
                      id="post-alt-text"
                      label="Describe this photo (alt text)"
                      value={singleAltText}
                      onChange={setSingleAltText}
                      onWrite={uploadedBlob ? () => describeSinglePhoto(uploadedBlob, uploadFile) : null}
                    />
                  )}
                </div>
              )}

              {uploadProgress !== null && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Uploading&hellip;</span>
                    <span>{Math.round(uploadProgress)}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-label="Upload progress"
                    aria-valuenow={Math.round(uploadProgress)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-200"
                      style={{ width: `${uploadProgress}%` }}
                    />
                  </div>
                </div>
              )}

              {/* 07c: more photos, up to 10. Offered once a single photo has
                  uploaded, or for a set below the limit. */}
              {(photoSet.length > 0
                ? photoSet.length < MAX_POST_MEDIA
                : Boolean(uploadFile && uploadedBlob && MULTI_PHOTO_MIME_TYPES.includes(uploadFile.type))) && (
                <AddPhotosButton
                  disabled={preparingPhotos}
                  onPick={(files) => void attachPickedPhotos(files, false)}
                />
              )}
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="post-caption">Caption</Label>
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-input accent-[var(--primary)]"
                  checked={autoCaptionEnabled}
                  onChange={(event) => setAutoCaptionEnabled(event.target.checked)}
                />
                <span>Generate a caption when media is added</span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  runAutoCaptionFromMedia(
                    photoSet.length > 0
                      ? { overwrite: true, blobOverride: photoSet[0].blob ?? undefined, fileOverride: photoSet[0].file }
                      : { overwrite: true },
                  )
                }
                loading={autoCaptionLoading}
                disabled={autoCaptionLoading || !(photoSet.length > 0 ? photoSet[0].blob : uploadedBlob)}
              >
                {!autoCaptionLoading && <Sparkles className="h-4 w-4" aria-hidden />}
                Caption from media
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleEnhanceCaption}
                loading={enhancingCaption}
                disabled={enhancingCaption || !uploadCaption.trim()}
              >
                {!enhancingCaption && <Sparkles className="h-4 w-4" aria-hidden />}
                Enhance caption
              </Button>
            </div>
          </div>
          {/* 2026-11-01 scale audit (jobs, event size): no `maxLength` - it would
              silently truncate a paste; the counter + disabled submit make
              the cap visible instead. */}
          <Textarea
            id="post-caption"
            value={uploadCaption}
            onChange={(event) => setUploadCaption(event.target.value)}
            rows={3}
            placeholder="What do you want to say with this post?"
            aria-invalid={captionOver || undefined}
            aria-describedby="post-caption-count"
          />
          <CaptionCounter id="post-caption-count" text={uploadCaption} />
          {captionStoryNote ? <p className="text-xs text-muted-foreground">{captionStoryNote}</p> : null}
        </div>

        <PlatformCaptionEditor
          idPrefix="post-platform-caption"
          platforms={selectedPlatforms}
          caption={uploadCaption}
          overrides={platformOverrides}
          onChange={setPlatformOverrides}
          footer={footerSettings}
        />

        {pageView.showLocation ? (
        <div className="space-y-1.5">
          <Label htmlFor="post-location">
            Location <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <LocationAutocomplete
            id="post-location"
            value={uploadLocation}
            onChange={setUploadLocation}
            placeholder="Start typing a location..."
            className={cn(fieldBaseClasses, "h-10 px-3 py-2")}
          />
          <p className="text-xs text-muted-foreground">
            Type to search for locations. Will be added to Instagram, TikTok, and X posts. (YouTube
            requires manual location setting via Studio)
          </p>
        </div>
        ) : null}

        {tiktokSelected && activeMimeType && (
          <TikTokPostSettings
            metadata={tiktokMetadata}
            onChange={setTiktokMetadata}
            isVideo={activeMimeType.startsWith("video/")}
            privacyError={tiktokPrivacyError}
            commercialContentEnabled={tiktokCommercialEnabled}
            onCommercialContentEnabledChange={setTiktokCommercialEnabled}
            videoDurationSec={videoDurationSec}
            onBlockingChange={setTiktokBlockingReason}
          />
        )}
        {youtubeSelected && activeMimeType && (
          <YouTubePostSettings
            metadata={youtubeMetadata}
            onChange={setYoutubeMetadata}
          />
        )}
        {googleOptionsShown && (
          <GooglePostSettings metadata={googleMetadata} onChange={setGoogleMetadata} />
        )}
        {selectedPlatforms.includes("instagram") && activeMimeType && (
          <StoryPlacementSettings
            platform="instagram"
            choice={instagramChoice}
            fileCount={attachedFileCount}
            videoDurationSec={activeVideoDurationSec}
            onChange={setInstagramPlacement}
          />
        )}
        {selectedPlatforms.includes("facebook_page") && activeMimeType && (
          <StoryPlacementSettings
            platform="facebook_page"
            choice={facebookChoice}
            fileCount={attachedFileCount}
            videoDurationSec={activeVideoDurationSec}
            onChange={setFacebookPlacement}
          />
        )}

        {/* Task 7 — per-post platform targeting: defaults to every connected
            platform selected; unchecking one excludes it from the preview
            below, the TikTok/YouTube settings panels above, and the publish
            request. */}
        {connectedPlatforms.length > 0 ? (
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium text-foreground">Publish to</legend>
            <div className="flex flex-wrap gap-2">
              {platformChoices.map(({ platform, checked, disabledReason }) => {
                const disabled = disabledReason !== null;
                const reasonId = `post-platform-${platform}-reason`;
                return (
                  <label
                    key={platform}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-[var(--radius)] border px-3 py-1.5 text-sm transition-colors",
                      disabled
                        ? "cursor-not-allowed border-input text-muted-foreground opacity-60"
                        : checked
                          ? "cursor-pointer border-primary/40 bg-primary/10 text-foreground"
                          : "cursor-pointer border-input text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-input accent-[var(--primary)]"
                      checked={checked}
                      disabled={disabled}
                      aria-describedby={disabled ? reasonId : undefined}
                      onChange={(event) => {
                        setDeselected((prev) => {
                          const next = new Set(prev);
                          if (event.target.checked) next.delete(platform);
                          else next.add(platform);
                          return next;
                        });
                      }}
                    />
                    {platformLabel(platform)}
                    {disabled ? (
                      <span id={reasonId} className="text-xs">
                        ({disabledReason})
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            {platformAlert ? (
              <p className="text-xs text-destructive" role="alert">
                {platformAlert}
              </p>
            ) : null}
            {multiPhotoPlatformNotes(selectedPlatforms, photoSet.length).map((note) => (
              <p key={note.platform} className="text-xs text-muted-foreground">
                {note.text}
              </p>
            ))}
          </fieldset>
        ) : null}

        {/* Roadmap Phase 7 — live per-platform preview (spec §7.1): caption
            with footer, media thumbnail, and char-limit feedback for every
            SELECTED platform (Task 7 — narrowed from every connected platform
            to the chosen subset). Recomputed on every render, so it updates
            as the user types. */}
        <PlatformPreviewList
          platforms={selectedPlatforms}
          caption={uploadCaption}
          overrides={previewOverrides}
          user={footerSettings}
          mediaUrl={activeMediaUrl}
          mediaMimeType={activeMimeType}
          mediaCount={photoSet.length}
        />

        {/* Roadmap Phase 5 — publish timing: now / schedule / draft. */}
        <div className="space-y-3 pt-1">
          <div className="space-y-1.5">
            <span className="block text-sm font-medium text-foreground">
              When to publish
            </span>
            <div
              role="group"
              aria-label="When to publish"
              className="inline-flex flex-wrap gap-0.5 rounded-[var(--radius)] border border-input p-0.5"
            >
              {(
                [
                  ["now", "Publish now"],
                  ["schedule", "Schedule"],
                  ["draft", "Save draft"],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={publishMode === mode}
                  onClick={() => setPublishMode(mode)}
                  className={cn(
                    "rounded-[calc(var(--radius)-0.125rem)] px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    publishMode === mode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {publishMode === "schedule" && (
            <div className="space-y-1.5">
              <Label htmlFor="post-schedule">Publish at</Label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="post-schedule"
                  type="datetime-local"
                  value={scheduledForLocal}
                  min={minScheduleLocal || undefined}
                  onChange={(event) => {
                    setScheduledForLocal(event.target.value);
                    setSlotPresses(0);
                  }}
                  className={cn(fieldBaseClasses, "h-10 w-auto px-3 py-2")}
                />
                {slotData && slotData !== "error" ? (
                  slotData.slots.length > 0 ? (
                    <Button type="button" variant="outline" size="sm" onClick={fillNextFreeSlot}>
                      Next free slot
                    </Button>
                  ) : (
                    <Link
                      href="/settings#posting-times"
                      className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      Set your posting times
                    </Link>
                  )
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                Times are in {localTimeZoneLabel()} (your browser&apos;s timezone).
              </p>
              <RepeatControls
                repeat={repeat}
                onRepeatChange={setRepeat}
                count={repeatCount}
                onCountChange={setRepeatCount}
                storyChosen={storyChosen}
                dates={repeatDates}
                cautionNote={pageView.repeatNote}
              />
            </div>
          )}

          {/* TikTok guideline 4: the declaration sits right before the button. */}
          {tiktokSelected ? (
            <TikTokConsentDeclaration brandedContent={tiktokMetadata.brandedContent === true} />
          ) : null}

          {fileLostShown ? (
            <Alert variant="warning">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p>{FILE_LOST_MESSAGE}</p>
                <button
                  type="button"
                  onClick={() => setFileLost((current) => nextFileLostNotice(current, { type: "dismissed" }))}
                  className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                >
                  Dismiss
                </button>
              </div>
            </Alert>
          ) : null}
          {textNotice ? <p className="text-sm font-medium text-foreground">{textNotice}</p> : null}

          <div className="flex flex-wrap items-center gap-3">
            {/* No `disabled` for the zero-connection case: the gate above
                returns early, so the form only renders once at least one
                platform is connected. The span carries the hover text: a
                disabled button gets no hover events in every browser.
                Below md the publish bar takes its place (hidden, not just
                covered), so a screen reader meets one submit control. */}
            <span title={tiktokBlock ?? undefined} className="hidden md:inline">
            <Button type="submit" loading={control.loading} disabled={control.disabled}>
              {control.label}
            </Button>
            </span>
            {untouchedMessage ? (
              <p className="text-sm text-muted-foreground" role="status">
                {untouchedMessage}
              </p>
            ) : null}
            {tiktokBlock ? (
              <p className="text-sm text-muted-foreground" role="status">
                TikTok: {tiktokBlock}
              </p>
            ) : null}
          </div>
        </div>
      </form>

      {/* Task 7 — publish-now confirmation: immediate posts publish right
          away and can't be undone here, so confirm the target platforms
          (and any per-platform privacy) before performSubmit actually
          fires. Schedule/draft submit directly without this dialog. */}
      <ConfirmDialog
        open={confirmPublishOpen}
        onOpenChange={setConfirmPublishOpen}
        title={confirmCopy.title}
        description={
          <span className="block space-y-1">
            <span className="block">{confirmCopy.lead}</span>
            {confirmCopy.notice ? <span className="block font-medium">{confirmCopy.notice}</span> : null}
            {selectedPlatforms.includes("youtube") ? (
              <span className="block">YouTube privacy: {youtubeMetadata.privacyStatus}</span>
            ) : null}
            {selectedPlatforms.includes("tiktok") && tiktokMetadata.privacyLevel ? (
              <span className="block">TikTok privacy: {TIKTOK_PRIVACY_LABELS[tiktokMetadata.privacyLevel] ?? tiktokMetadata.privacyLevel}</span>
            ) : null}
            {/* TikTok guideline 4: the declaration also sits right above this
                dialog's Publish button. */}
            {selectedPlatforms.includes("tiktok") ? (
              <TikTokConsentDeclaration brandedContent={tiktokMetadata.brandedContent === true} />
            ) : null}
            {confirmCopy.trail ? <span className="block">{confirmCopy.trail}</span> : null}
          </span>
        }
        confirmText={confirmCopy.confirmText}
        onConfirm={performSubmit}
      />
      <PublishBar formId="create-post-form" control={control} dialogOpen={confirmPublishOpen} />
    </Card>
    {/* Room under the form so the fixed bar never covers its last control. */}
    <div aria-hidden className="h-[calc(7rem+env(safe-area-inset-bottom))] md:hidden" />
    </>
  );
}

const REPEAT_CHOICES: [RepeatInterval | "none", string][] = [
  ["none", "Does not repeat"],
  ["weekly", "Every week"],
  ["biweekly", "Every 2 weeks"],
  ["monthly", "Every month"],
];

/**
 * Repeat (brief 11), under the schedule time: how often and how many posts in
 * total, then the dates that will be created, in the viewer's zone.
 */
function RepeatControls(props: {
  repeat: RepeatInterval | "none";
  onRepeatChange: (repeat: RepeatInterval | "none") => void;
  count: number;
  onCountChange: (count: number) => void;
  storyChosen: boolean;
  dates: Date[];
  /** The caution under Repeat (repeatCautionNote), or null. */
  cautionNote: string | null;
}) {
  const { repeat, count, storyChosen, dates } = props;
  const on = repeat !== "none" && !storyChosen;
  return (
    <div className="space-y-1.5 pt-2">
      <Label htmlFor="post-repeat">Repeat</Label>
      <Select
        id="post-repeat"
        value={storyChosen ? "none" : repeat}
        disabled={storyChosen}
        onChange={(event) => props.onRepeatChange(event.target.value as RepeatInterval | "none")}
      >
        {REPEAT_CHOICES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      {storyChosen ? <p className="text-xs text-muted-foreground">{REPEAT_STORY_MESSAGE}</p> : null}
      {on ? (
        <div className="space-y-1.5">
          <Label htmlFor="post-repeat-count">How many times in total</Label>
          <Select
            id="post-repeat-count"
            value={String(count)}
            onChange={(event) => props.onCountChange(Number(event.target.value))}
          >
            {Array.from({ length: REPEAT_MAX_COUNT - REPEAT_MIN_COUNT + 1 }, (_, i) => i + REPEAT_MIN_COUNT).map(
              (n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ),
            )}
          </Select>
          {dates.length > 0 ? (
            <div className="text-sm text-foreground">
              <p className="text-xs text-muted-foreground">This creates {dates.length} posts:</p>
              <ul className="mt-1 list-disc pl-5">
                {dates.map((date) => (
                  <li key={date.getTime()}>
                    {date.toLocaleString(undefined, {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Pick a date and time to see the dates.</p>
          )}
          {props.cautionNote ? (
            <p className="text-xs text-muted-foreground">{props.cautionNote}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Lightweight placeholder for the Suspense boundary `useSearchParams`
 * requires — resolves near-instantly since this route is already dynamic
 * (the page reads the session via `getCurrentUser`), so this is rarely, if
 * ever, actually seen. */
function CreatePostFormSkeleton() {
  return (
    <Card className="space-y-5 p-6">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-10 w-32" />
    </Card>
  );
}

export interface CreatePostFormProps {
  /**
   * Roadmap Phase 7 — footer settings for the Preview section, projected
   * server-side by `app/posts/new/page.tsx` (SEC-1: only companyWebsite /
   * defaultHashtags, never the full `User` row). Optional so existing/other
   * callers of `CreatePostForm` keep working unchanged.
   */
  footerSettings?: CaptionFooterUser;
  /**
   * 2026-11-01 audit — a member in a workspace that requires approval:
   * publish-now is submitted for an owner's review rather than published, so
   * the confirmation dialog says "Submit for approval". Optional; defaults to
   * the original publish-now confirmation.
   */
  holdsForApproval?: boolean;
  /**
   * 2026-11-01 audit (M3) — id of the workspace the page was rendered for,
   * sent with the create request so a workspace switched in another tab is
   * refused (409) rather than posted into. Required (final review, T9) so the
   * compiler enforces it for every caller; the API field itself stays optional
   * for other clients.
   */
  workspaceId: string;
  /** 2026-11-10 — the workspace's default Google button (app/posts/new/page.tsx). */
  googleButtonDefault?: GoogleButton | null;
}

/**
 * `useSearchParams` (used by the reuse-mode fetch above) requires a Suspense
 * boundary around its consumer during static rendering; self-contained here
 * so the parent page (`app/posts/new/page.tsx`) doesn't need to know about
 * it — mirrors how `ConnectionsSection` wraps `LinkedInSetupDialog`.
 */
export function CreatePostForm({
  footerSettings,
  holdsForApproval,
  workspaceId,
  googleButtonDefault,
}: CreatePostFormProps) {
  return (
    <Suspense fallback={<CreatePostFormSkeleton />}>
      <CreatePostFormInner
        footerSettings={footerSettings}
        holdsForApproval={holdsForApproval}
        workspaceId={workspaceId}
        googleButtonDefault={googleButtonDefault}
      />
    </Suspense>
  );
}
