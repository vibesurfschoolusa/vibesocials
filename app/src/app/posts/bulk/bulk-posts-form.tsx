"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { upload } from "@vercel/blob/client";
import type { Platform } from "@prisma/client";
import { UploadCloud } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/load-error";
import { buttonVariants } from "@/components/ui/buttonVariants";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConnections } from "@/hooks/useConnections";
import { generateBlobKey, uploadSizePayload } from "@/lib/blobKey";
import { focusAfterPress } from "@/lib/focusAfter";
import {
  BULK_DRAFTS_NOTE,
  BULK_MAX_FILES,
  BULK_NO_TIME_MESSAGE,
  BULK_TIKTOK_NOTE,
  BULK_TOO_MANY_FILES_MESSAGE,
  BULK_YOUTUBE_PRIVACY_DEFAULT,
  UNREADABLE_BODY,
  type BulkCaptionStatus,
  type BulkFinishMode,
  type BulkScheduleControls,
  type BulkSendResponse,
  type BulkUploadStatus,
  allRowsCreated,
  applySchedule,
  applySlotSchedule,
  createdRowWhen,
  captionProgressText,
  classifySendResponse,
  confirmedInQueue,
  filesThatFit,
  minFirstDay,
  minRowTime,
  moveRow,
  nextWork,
  platformsForRow,
  refreshedFirstDay,
  rowSendBlock,
  rowsToSend,
  youtubePrivacyShown,
} from "@/lib/bulkPosts";
import { Select } from "@/components/ui/select";
import type { YouTubePostMetadata } from "@/server/platforms/types";
import type { UploadedBlob } from "@/lib/createPostRequest";
import { requestPhotoDescription } from "@/components/composer/attached-photos";
import { StoryPlacementSettings } from "@/components/story-placement";
import { captureVideoFrame } from "@/lib/captureVideoFrame";
import { coverBlobPathname } from "@/lib/coverBlobPath";
import {
  GOOGLE_BUTTON_LABELS,
  GOOGLE_BUTTON_TYPES,
  type GoogleButton,
  type GoogleButtonType,
} from "@/lib/googlePostOptions";
import { initialPlacements, type PlacementChoice } from "@/lib/storyPlacement";
import { coverRequestFields, type CoverChoice, type UploadedCoverImage } from "@/lib/videoCover";
import type { GoogleBusinessPostMetadata } from "@/server/platforms/types";
import { pickFromMedia, skippedMediaMessage } from "@/lib/bulkMedia";
import { splitDroppedFiles } from "@/lib/clientPage";
import { cn } from "@/lib/cn";
import type { MediaItemDto } from "@/lib/mediaDto";
import { extractVideoFrames } from "@/lib/extractVideoFrames";
import { PLATFORM_ORDER, platformLabel, SETTINGS_CONNECTIONS_HREF } from "@/lib/platforms";
import { prepareUploadFile } from "@/lib/prepareUploadFile";
import { localDateTimeToUtcIso, localTimeZoneLabel, SCHEDULED_TIME_TOO_SOON_MESSAGE } from "@/lib/scheduling";
import { readScheduledTimes, type ScheduledTimes } from "@/lib/scheduledTimesRead";
import { explainUploadFailure, uploadRouteUrl } from "@/lib/uploadFailure";
import { SetPostingTimesPrompt } from "@/components/posting-times-prompt";
import { ALT_TEXT_TOO_LONG_TEXT, BulkPostRow, altTextStoredLength, captionFailedText, captionLocked } from "./bulk-post-row";
import { ALT_TEXT_MAX } from "@/lib/altText";
import { MediaPickerDialog } from "./media-picker-dialog";
import { BatchSettingsFieldset } from "./batch-settings";
import {
  BULK_CAPTION_LOST_TEXT,
  BULK_COVER_FAILED_TEXT,
  automaticRequestMayGo,
  autoCaptionRequestBody,
  buildBulkRowBody,
  bulkExtrasBlock,
  bulkGoogleMetadataError,
  bulkRowResultText,
  bulkStoryChoice,
  captionThenDescribe,
  coverUploadFailedText,
  describePhotoOnce,
  rowAiRequests,
  type RowAiRequest,
  initialBulkGoogleMetadata,
  readAiCaptionsChoice,
  readVideoDuration,
  requestImprovedCaption,
  rowStoryRefusal,
  saveAiCaptionsChoice,
  type BulkStories,
} from "./bulkExtras";
import { fetchOrNoAnswer, isNoAnswer } from "@/lib/requestNoAnswer";
import { waitSecondsOf } from "@/lib/tooManyTriesText";

export interface BulkRow {
  id: string;
  fileName: string;
  mimeType: string;
  upload: BulkUploadStatus;
  /** 0-100 while uploading. */
  progress: number | null;
  uploadError: string | null;
  /**
   * R48 publishing L4: why the upload failed. "file": the file itself was
   * refused while it was prepared (its type, a photo that can't be converted),
   * so a Retry would fail the same way and only Remove is offered, as on /u.
   * "network": anything after that, which a Retry may fix.
   */
  uploadErrorKind: "file" | "network" | null;
  blob: UploadedBlob | null;
  /** Set for a row made from a Media item: it is posted by id, never uploaded again. */
  mediaItemId: string | null;
  caption: string;
  captionStatus: BulkCaptionStatus;
  /** Set by "Write again": the new caption replaces what is in the box. */
  captionOverwrite: boolean;
  /** The sentence the row shows when no caption came back (captionFailedText). */
  captionError: string | null;
  /** "Improve" is waiting for its answer; the caption box is read-only meanwhile. */
  improving: boolean;
  /** The line under the box when Improve got no new caption (the caption is kept). */
  improveError: string | null;
  /** A photo's description (alt text), as the AI wrote it or the user typed it. */
  altText: string;
  /** The AI was asked for the description already: once per photo per batch. */
  altTextAsked: boolean;
  altTextWriting: boolean;
  /** Why "Write it for me" got no description (Media photos only). */
  altTextError: string | null;
  /** A video's length in seconds; undefined until read, null when it could not be. */
  durationSec: number | null | undefined;
  /** A video's cover, as Create's picker sets it. */
  cover: CoverChoice;
  /** datetime-local value. */
  when: string;
  whenSetByHand: boolean;
  /** The created post's id; a row that has one is never sent again. */
  postId: string | null;
  /** The last send got no clear answer: the post may exist, so it is not sent again on its own. */
  uncertain: boolean;
  /** The button that send came from, so "It is in the Queue" knows whether the post holds a time. */
  uncertainMode: BulkFinishMode | null;
  sending: boolean;
  result: string | null;
  /** The server's refusal, or another send failure, as its sentence. */
  sendError: string | null;
  /** An object URL of the prepared photo, or a frame of the video once one was read. */
  thumbnail: string | null;
}

function newRow(file: Pick<File, "name" | "type">): BulkRow {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    fileName: file.name,
    mimeType: file.type,
    upload: "queued",
    progress: null,
    uploadError: null,
    uploadErrorKind: null,
    blob: null,
    mediaItemId: null,
    caption: "",
    captionStatus: "waiting",
    captionOverwrite: false,
    captionError: null,
    improving: false,
    improveError: null,
    altText: "",
    altTextAsked: false,
    altTextWriting: false,
    altTextError: null,
    durationSec: undefined,
    cover: { kind: "default" },
    when: "",
    whenSetByHand: false,
    postId: null,
    uncertain: false,
    uncertainMode: null,
    sending: false,
    result: null,
    sendError: null,
    thumbnail: null,
  };
}

function newMediaRow(item: MediaItemDto): BulkRow {
  return {
    ...newRow({ name: item.originalFilename, type: item.mimeType }),
    upload: "done",
    blob: {
      url: item.storageLocation,
      filename: item.originalFilename,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
    },
    mediaItemId: item.id,
    // A photo shows as it is stored; a video's thumbnail comes from the frames read for its caption.
    thumbnail: item.mimeType.startsWith("image/") ? item.storageLocation : null,
  };
}

const noSubscription = () => () => {};

/** What a row's own checks read from the batch: its platforms, Feed or Story, and the Google options. */
export interface BulkBatchCheck {
  selectedPlatforms: readonly Platform[];
  stories: BulkStories;
  /** bulkGoogleMetadataError while Google is chosen, else null. */
  googleError: string | null;
}

type RowCheck = Pick<BulkRow, "mimeType" | "durationSec" | "caption" | "when" | "blob"> &
  Partial<Pick<BulkRow, "altText" | "uploadErrorKind">>;

/** R48 publishing L4: a file refused while it was prepared, and the line a press leaves on its row. */
export const BULK_FILE_REFUSED_TEXT = "This file can't be sent. Remove it, then choose a photo or video.";
export const BULK_FILE_LEFT_OUT_TEXT = "This file can't be sent, so it was left out. Remove it.";

/** Why a press would not send this row, judged against the clock `at` of the press, or null. */
export function rowLocalBlock(row: RowCheck, mode: BulkFinishMode, at: Date, batch: BulkBatchCheck): string | null {
  // Not "Retry it": a Retry would refuse the same file again.
  if (row.uploadErrorKind === "file") return BULK_FILE_LEFT_OUT_TEXT;
  const platforms = platformsForRow(batch.selectedPlatforms, row.mimeType).platforms;
  return (
    rowSendBlock(
      { id: "", uploaded: row.blob !== null, caption: row.caption, platforms, when: row.when, postId: null, uncertain: false },
      mode,
      at,
    ) ??
    bulkExtrasBlock({
      mimeType: row.mimeType,
      durationSec: row.durationSec,
      platforms,
      stories: batch.stories,
      googleError: batch.googleError,
    }) ??
    // R45 pages-a L3: the route would cut a longer description.
    (row.mimeType.startsWith("image/") && altTextStoredLength(row.altText ?? "") > ALT_TEXT_MAX ? ALT_TEXT_TOO_LONG_TEXT : null)
  );
}

/** A press a row's own checks refused (R33 pages L7): its mode and clock. */
export interface RefusedPress {
  mode: BulkFinishMode;
  at: number;
}

/**
 * R33 pages L7, one rule with Create's pressRefusalLine: the row's send line
 * as shown. A server refusal is its sentence; a press the row's own checks
 * refused is the live check, so Story switched to Feed, a mended Google link
 * or an edited row takes the line (and its alert) away at once.
 */
export function rowSendLine(
  row: RowCheck & Pick<BulkRow, "sendError">,
  press: RefusedPress | undefined,
  batch: BulkBatchCheck,
): string | null {
  if (row.sendError) return row.sendError;
  if (!press) return null;
  return rowLocalBlock(row, press.mode, new Date(press.at), batch);
}

/** The refused presses still refusing: a row whose check passed is dropped (the same map when none is). */
export function refusedPressesKept(
  presses: ReadonlyMap<string, RefusedPress>,
  rows: readonly (RowCheck & Pick<BulkRow, "id">)[],
  batch: BulkBatchCheck,
): ReadonlyMap<string, RefusedPress> {
  const kept = new Map<string, RefusedPress>();
  for (const row of rows) {
    const press = presses.get(row.id);
    if (press && rowLocalBlock(row, press.mode, new Date(press.at), batch) !== null) kept.set(row.id, press);
  }
  return kept.size === presses.size ? presses : kept;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * R11-client-journey L2: only the owner can connect, so a member reads who can.
 * R12-new-customer L3: TikTok is never offered here, so with only TikTok
 * connected (`onlyTikTok`) "no platform is connected" would be untrue.
 */
export function NoPlatformConnectedLine({ isMember, onlyTikTok = false }: { isMember: boolean; onlyTikTok?: boolean }) {
  const state = onlyTikTok
    ? "Add many posts to every platform except TikTok, and none of those is connected yet."
    : "No platform here is connected yet.";
  return isMember ? (
    <p className="text-sm text-muted-foreground">
      {`${state} The workspace owner can connect accounts for this workspace.`}
    </p>
  ) : (
    <p className="text-sm text-muted-foreground">
      {state}{" "}
      <Link href={SETTINGS_CONNECTIONS_HREF} className="text-primary underline-offset-4 hover:underline">
        Connect one in Settings
      </Link>
      .
    </p>
  );
}

export function BulkPostsForm({
  workspaceId,
  initialMedia = [],
  skippedMedia = 0,
  googleButtonDefault = null,
  isMember = false,
}: {
  workspaceId: string;
  /** R11-client-journey L2: the viewer is a member (page.tsx); for the no-platform line. */
  isMember?: boolean;
  /** The workspace's default Google button, which the batch's Google options start from (as on Create). */
  googleButtonDefault?: GoogleButton | null;
  /** Media items to start with (the Media page's "Schedule with Add many"). */
  initialMedia?: MediaItemDto[];
  /** How many selected items the page left out. */
  skippedMedia?: number;
}) {
  const [rows, setRows] = useState<BulkRow[]>([]);
  // The latest rows, for the async upload/caption/send loops (state read inside
  // them would be the value from when they started).
  const rowsRef = useRef<BulkRow[]>([]);
  const queueLinkRef = useRef<HTMLAnchorElement>(null);
  const filesRef = useRef(new Map<string, File>());
  const workingRef = useRef(false);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [tooMany, setTooMany] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [duplicateNote, setDuplicateNote] = useState(0);
  const [sendingMode, setSendingMode] = useState<BulkFinishMode | null>(null);
  // R45 second review: the description a refused press sends the focus to.
  // The rows are locked (their fields disabled) while the press sends, and a
  // disabled field loses the focus, so it moves once the press has ended and
  // the fields are enabled again (the effect below); `altFocusAsked` makes
  // that render happen even when nothing was sent.
  const altFocusRef = useRef<string | null>(null);
  const [altFocusAsked, setAltFocusAsked] = useState(0);
  useEffect(() => {
    if (sendingMode !== null || !altFocusRef.current) return;
    const id = altFocusRef.current;
    altFocusRef.current = null;
    altFieldsRef.current.get(id)?.focus();
  }, [sendingMode, altFocusAsked]);
  // R33 pages L7: the rows the last press's own checks refused (rowSendLine).
  const [refusedPresses, setRefusedPresses] = useState<ReadonlyMap<string, RefusedPress>>(() => new Map());
  // F7 (R1 M2): "Write captions with AI". Off, no file goes to the AI and rows
  // keep an empty caption box. On until this browser turned it off; read after
  // mount, since the server cannot know (a different first render is React #418).
  const [aiCaptions, setAiCaptionsState] = useState(true);
  const aiCaptionsRef = useRef(true);
  useEffect(() => {
    const on = readAiCaptionsChoice(() => window.localStorage);
    aiCaptionsRef.current = on;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads browser storage once after hydration
    setAiCaptionsState(on);
  }, []);
  function setAiCaptions(on: boolean) {
    aiCaptionsRef.current = on;
    setAiCaptionsState(on);
    saveAiCaptionsChoice(() => window.localStorage, on);
  }

  // The first day starts empty and is filled on mount: the server's clock and
  // zone are not the browser's, and a different first render is React #418.
  const [controls, setControls] = useState<BulkScheduleControls>(() => ({
    firstDay: "",
    timeOfDay: "18:00",
    everyDays: 1,
  }));
  const controlsRef = useRef(controls);
  // "Use my posting times" (brief 11): rows take the next free slots instead of
  // the first day / time / every N days spread. The slots and the times posts
  // already hold come from GET /api/posts/scheduled-times, read once.
  const [useSlots, setUseSlots] = useState(false);
  const useSlotsRef = useRef(false);
  // R32: `refused` when the read was refused for this page's workspace (another tab switched).
  const [slotData, setSlotData] = useState<ScheduledTimes | { refused: string } | "error" | null>(null);
  const slotDataRef = useRef<ScheduledTimes | null>(null);
  // R45 publishing L2: rows the last press refused for a time that has passed.
  // Each keeps that time, and its line, until the person edits it.
  const timeHeldRef = useRef<ReadonlySet<string>>(new Set());
  // R45 lead review: each photo row's description field, by row id.
  const altFieldsRef = useRef(new Map<string, HTMLInputElement>());
  // Raw text of the "every N days" box, so it can be cleared while typing.
  const [everyDaysText, setEveryDaysText] = useState("1");
  // Once the user picks a first day it is theirs; until then it follows "tomorrow".
  const firstDaySetByUserRef = useRef(false);
  // The clock behind the inputs' `min` and the "tomorrow" default, kept current
  // while the page stays open. The press itself reads a fresh clock.
  // Null until mount, for the same reason as the first day.
  const [now, setNow] = useState<Date | null>(null);
  const zone = useSyncExternalStore(noSubscription, localTimeZoneLabel, () => null);
  const [youtubePrivacy, setYoutubePrivacy] =
    useState<YouTubePostMetadata["privacyStatus"]>(BULK_YOUTUBE_PRIVACY_DEFAULT);
  // Batch settings Create has per post, applied to every row.
  const [googleMetadata, setGoogleMetadata] = useState<GoogleBusinessPostMetadata>(() =>
    initialBulkGoogleMetadata(googleButtonDefault),
  );
  const [instagramPlacement, setInstagramPlacement] = useState<PlacementChoice>(() => initialPlacements().instagram);
  const [facebookPlacement, setFacebookPlacement] = useState<PlacementChoice>(() => initialPlacements().facebook);
  // One cover picker open at a time: its field ids and radio name are fixed.
  const [coverOpenId, setCoverOpenId] = useState<string | null>(null);
  // Object URLs made for photo thumbnails, revoked on removal and on unmount.
  const objectUrlsRef = useRef(new Map<string, string>());
  // Set on unmount: a photo still being prepared then gets no object URL, since
  // the unmount cleanup below has already run and would never revoke it.
  const unmountedRef = useRef(false);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  function revokeThumbnail(id: string) {
    const url = objectUrlsRef.current.get(id);
    if (url) URL.revokeObjectURL(url);
    objectUrlsRef.current.delete(id);
  }

  const { connections, loading: connectionsLoading, error: connectionsError, reload } = useConnections(workspaceId);
  // TikTok is never offered here: it needs choices for each video.
  const offeredPlatforms = useMemo(
    () =>
      PLATFORM_ORDER.filter(
        (platform) =>
          platform !== "tiktok" && connections?.some((c) => c.platform === platform && c.connected),
      ),
    [connections],
  );
  const tiktokConnected = connections?.some((c) => c.platform === "tiktok" && c.connected) ?? false;
  const [deselected, setDeselected] = useState<Set<Platform>>(new Set());
  const selectedPlatforms = offeredPlatforms.filter((platform) => !deselected.has(platform));

  // R41 publishing L1, L2: each row's running AI requests, so typing in a box lets its own go.
  const [rowRequests] = useState(rowAiRequests);

  function updateRows(change: (rows: BulkRow[]) => BulkRow[]) {
    const next = change(rowsRef.current);
    rowsRef.current = next;
    setRows(next);
  }

  function updateRow(id: string, patch: Partial<BulkRow> | ((row: BulkRow) => Partial<BulkRow>)) {
    updateRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...(typeof patch === "function" ? patch(row) : patch) } : row)),
    );
  }

  /**
   * R45 publishing L1, L2: the one rule for row times. It runs after every
   * change in which rows hold a time (a row added, moved, removed, sent,
   * confirmed in the Queue, sent again, or released from a hold). A row held
   * for its refused time counts as locked here, so it is never moved without
   * a word.
   */
  function respread(change: (rows: BulkRow[]) => BulkRow[] = (r) => r) {
    const slotInfo = useSlotsRef.current ? slotDataRef.current : null;
    const held = timeHeldRef.current;
    updateRows((current) => {
      const changed = change(current);
      const marked = changed.map((row) => (held.has(row.id) && !row.whenSetByHand ? { ...row, whenSetByHand: true } : row));
      const spread = slotInfo
        ? applySlotSchedule(marked, slotInfo.slots, slotInfo.taken, new Date())
        : applySchedule(marked, controlsRef.current);
      return spread.map((row, index) => (marked[index] !== changed[index] ? { ...row, whenSetByHand: false } : row));
    });
  }

  /** Ends a row's hold; true when it had one. */
  function dropTimeHold(id: string): boolean {
    if (!timeHeldRef.current.has(id)) return false;
    const held = new Set(timeHeldRef.current);
    held.delete(id);
    timeHeldRef.current = held;
    return true;
  }

  /** An edit to a held row: it joins the spread again. */
  function releaseTimeHold(id: string) {
    if (dropTimeHold(id)) respread();
  }

  useEffect(() => {
    let cancelled = false;
    // R32 new-customer L3: the times of the workspace this page was drawn for only.
    void readScheduledTimes(workspaceId).then((read) => {
      if (cancelled) return;
      if (read !== "error" && !("refused" in read)) slotDataRef.current = read;
      setSlotData(read);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  function changeUseSlots(on: boolean) {
    useSlotsRef.current = on;
    setUseSlots(on);
    // R45 lead review: a change to the batch's schedule is an edit to every row.
    timeHeldRef.current = new Set();
    respread();
  }

  async function uploadRow(id: string) {
    const file = filesRef.current.get(id);
    if (!file) return;
    updateRow(id, { upload: "working", progress: null, uploadError: null, uploadErrorKind: null, sendError: null });
    let preparing = true;
    try {
      // Same preparation as Create: HEIC -> JPEG, big photos shrunk, unsupported types refused.
      const prepared = await prepareUploadFile(file);
      preparing = false;
      filesRef.current.set(id, prepared);
      // A photo's thumbnail is the prepared file (a HEIC original would not show).
      // A video's comes from the frames read for its caption (captionRow).
      let thumbnail: string | undefined;
      if (
        prepared.type.startsWith("image/") &&
        !unmountedRef.current &&
        rowsRef.current.some((r) => r.id === id)
      ) {
        revokeThumbnail(id);
        thumbnail = URL.createObjectURL(prepared);
        objectUrlsRef.current.set(id, thumbnail);
      }
      updateRow(id, { fileName: prepared.name, mimeType: prepared.type, ...(thumbnail ? { thumbnail } : {}) });
      let settled = false;
      const blob = await upload(generateBlobKey(prepared), prepared, {
        access: "public",
        handleUploadUrl: uploadRouteUrl(workspaceId),
        clientPayload: uploadSizePayload(prepared),
        onUploadProgress: (event) => {
          if (!settled) updateRow(id, { progress: event.percentage });
        },
      }).then(
        (result) => {
          settled = true;
          return result;
        },
        async (error: unknown) => {
          settled = true;
          // A full workspace storage reaches the user as its own sentence.
          throw await explainUploadFailure(error, workspaceId);
        },
      );
      updateRow(id, {
        upload: "done",
        progress: null,
        blob: { url: blob.url, filename: prepared.name, mimeType: prepared.type, sizeBytes: prepared.size },
      });
    } catch (error: unknown) {
      console.error("[Add many] Upload failed", error);
      updateRow(id, {
        upload: "failed",
        progress: null,
        uploadErrorKind: preparing ? "file" : "network",
        uploadError: preparing
          ? errorMessage(error, BULK_FILE_REFUSED_TEXT)
          : errorMessage(error, "The upload failed. Retry it or remove it."),
      });
    }
  }

  // What the caption step reads from the row's own file, in this browser: a
  // video's length and still frames. Nothing is sent anywhere.
  async function readRowMedia(id: string, row: BulkRow, blob: UploadedBlob): Promise<string[]> {
    // Read once, for the Story length rule and the cover slider.
    if (blob.mimeType.startsWith("video/") && row.durationSec === undefined) {
      const durationSec = await readVideoDuration(filesRef.current.get(id) ?? blob.url);
      updateRow(id, { durationSec });
    }
    // For a video, a few still frames let the AI see it, as on Create.
    const frames = blob.mimeType.startsWith("video/")
      ? await extractVideoFrames(filesRef.current.get(id) ?? blob.url)
      : [];
    // The first of those frames doubles as the video's thumbnail, at no extra cost.
    if (frames.length > 0) {
      updateRow(id, (current) => (current.thumbnail ? {} : { thumbnail: frames[0] }));
    }
    return frames;
  }

  // "Write captions with AI" off: the row's own reads, then an empty caption box for the person.
  async function captionRowWithoutAi(id: string) {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row?.blob) return;
    updateRow(id, { captionStatus: "writing", captionError: null, improveError: null });
    try {
      await readRowMedia(id, row, row.blob);
    } catch (error: unknown) {
      console.error("[Add many] Reading the video failed", error);
    }
    updateRow(id, { captionStatus: "done", captionOverwrite: false });
  }

  async function captionRow(id: string) {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row?.blob) return;
    const blob = row.blob;
    updateRow(id, { captionStatus: "writing", captionError: null, improveError: null });
    // R41 publishing L1: typing in the box lets this go (onCaptionChange). Lead
    // review: only the AI part. The row's own read (a video's length, thumbnail,
    // frames) still finishes before it counts as done, so Schedule all and the
    // Story length check never see a video whose length isn't read yet.
    const request = rowRequests.start(id, "caption");
    const letGoByTyping = () => updateRow(id, { captionStatus: "done", captionOverwrite: false });
    try {
      const frames = await readRowMedia(id, row, blob);
      if (!request.live()) {
        letGoByTyping();
        return;
      }
      // R39 publishing L1, R40 L2: turned off, or the row removed, during the
      // frame grab: nothing is sent (updating a removed row changes nothing).
      // R41 publishing L1: nor for a box with typed text, unless Write again.
      const now = rowsRef.current.find((r) => r.id === id);
      const box = now && { text: now.caption, overwrite: now.captionOverwrite };
      if (!automaticRequestMayGo(aiCaptionsRef, now !== undefined, box)) {
        updateRow(id, { captionStatus: "done", captionOverwrite: false });
        return;
      }
      // Built from the rows as they are now, after the frames were read, so the
      // other rows' latest captions go with it and this one does not repeat them.
      const response = await fetchOrNoAnswer("/api/posts/auto-caption", {
        method: "POST",
        signal: request.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(autoCaptionRequestBody(rowsRef.current, id, blob, frames, workspaceId)),
      });
      const data = (await response.json().catch(() => null)) as
        | { caption?: unknown; error?: unknown; code?: unknown }
        | null;
      if (!request.live()) {
        letGoByTyping();
        return;
      }
      if (!response.ok || typeof data?.caption !== "string" || !data.caption.trim()) {
        console.error("[Add many] Caption failed", { status: response.status, code: data?.code, error: data?.error });
        updateRow(id, {
          captionStatus: "failed",
          captionOverwrite: false,
          // R42 review: the limit's own wait, from the body, else Retry-After.
          captionError: captionFailedText(
            response.ok ? null : response.status,
            data?.code,
            waitSecondsOf(data, response.headers.get("Retry-After")),
            data?.error,
          ),
        });
        return;
      }
      const caption = data.caption;
      updateRow(id, (current) => ({
        captionStatus: "done",
        captionOverwrite: false,
        // Never replace what the user typed meanwhile, unless they asked for a new one.
        caption: current.captionOverwrite || !current.caption.trim() ? caption : current.caption,
      }));
    } catch (error: unknown) {
      // Let go by typing (the fetch aborted): the person's text stands, and there is nothing to say.
      if (!request.live()) {
        letGoByTyping();
        return;
      }
      console.error("[Add many] Caption failed", error);
      updateRow(id, {
        captionStatus: "failed",
        captionOverwrite: false,
        // No answer: the AI may have written one that isn't shown. Reading the file's frames: plain sentence.
        captionError: isNoAnswer(error) ? BULK_CAPTION_LOST_TEXT : captionFailedText(null, undefined),
      });
    } finally {
      request.end();
    }
  }

  // A photo's description, right after its first caption whatever came of it:
  // one AI call per photo from the computer per batch (Write again does not ask
  // again). Optional, so a failure leaves the field empty and says nothing.
  // R41 publishing L1: a description already typed asks nothing; typing during
  // the call lets it go (onAltTextChange), and the typed text stays.
  async function describeRow(id: string) {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row?.blob) return;
    if (!automaticRequestMayGo(aiCaptionsRef, true, { text: row.altText })) {
      updateRow(id, { altTextAsked: true });
      return;
    }
    updateRow(id, { altTextAsked: true, altTextWriting: true });
    const request = rowRequests.start(id, "altText");
    const text = await describePhotoOnce(row.blob, workspaceId, undefined, request.signal);
    request.end();
    describedAs(id, row.altText, text, request);
  }

  // R41 L1 (= publishing L2): a description answer is written only while the
  // field reads as it did at the press. One let go (typing, or a newer press)
  // changes nothing: whatever let it go already ended the row's wait.
  function describedAs(id: string, atPress: string, text: string, request: RowAiRequest) {
    if (!request.live()) return;
    updateRow(id, (current) => ({
      altTextWriting: false,
      ...(text && current.altText === atPress ? { altText: text } : {}),
    }));
  }

  // A Media photo's "Write it for me": one AI call per press, as on Create, and
  // its sentence under the field when it fails.
  async function writeDescription(id: string) {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row?.blob || row.altTextWriting) return;
    updateRow(id, { altTextWriting: true, altTextError: null });
    // R41 L1: typing in the field lets it go (onAltTextChange), and the typed text stays.
    const request = rowRequests.start(id, "altText");
    try {
      const text = await requestPhotoDescription(row.blob, workspaceId, undefined, request.signal);
      describedAs(id, row.altText, text, request);
    } catch (error: unknown) {
      if (!request.live()) return;
      updateRow(id, {
        altTextWriting: false,
        altTextError: error instanceof Error && error.message ? error.message : "The AI couldn't describe this photo.",
      });
    } finally {
      request.end();
    }
  }

  async function improveRow(id: string) {
    const row = rowsRef.current.find((r) => r.id === id);
    if (!row || row.improving || !row.caption.trim()) return;
    updateRow(id, { improving: true, captionError: null, improveError: null, sendError: null });
    const result = await requestImprovedCaption(row.caption, workspaceId);
    updateRow(
      id,
      result.ok ? { improving: false, caption: result.caption } : { improving: false, improveError: result.error },
    );
  }

  // The cover's image, uploaded as Create does: the chosen file, or the chosen
  // frame captured in the browser, under this workspace's covers/ folder (the
  // posts route takes no other). Null when it could not be had.
  async function uploadCoverImage(
    choice: CoverChoice,
    source: File | string,
  ): Promise<{ image: UploadedCoverImage | null; error: string | null }> {
    try {
      const file =
        choice.kind === "upload"
          ? choice.file
          : choice.kind === "frame"
            ? await captureVideoFrame(source, choice.timeMs)
            : null;
      if (!file) return { image: null, error: null };
      const blob = await upload(coverBlobPathname(workspaceId), file, {
        access: "public",
        handleUploadUrl: uploadRouteUrl(workspaceId),
        clientPayload: uploadSizePayload(file),
      });
      return { image: { url: blob.url, mimeType: file.type, sizeBytes: file.size }, error: null };
    } catch (error: unknown) {
      console.error("[Add many] Cover upload failed", error);
      // R21 publishing-flow L1: why it failed (signed out, storage full), as a file's upload says.
      return { image: null, error: await coverUploadFailedText(error, workspaceId) };
    }
  }

  // One upload or caption at a time, in list order, until nothing is left.
  async function runWork() {
    if (workingRef.current) return;
    workingRef.current = true;
    try {
      for (;;) {
        const work = nextWork(rowsRef.current.map((r) => ({ id: r.id, upload: r.upload, caption: r.captionStatus })));
        if (!work) break;
        if (work.step === "upload") await uploadRow(work.id);
        else {
          await captionThenDescribe(work.id, {
            writeCaption: captionRow,
            withoutAi: captionRowWithoutAi,
            row: (rowId) => {
              const row = rowsRef.current.find((r) => r.id === rowId);
              return row
                ? {
                    mimeType: row.mimeType,
                    uploaded: row.blob !== null,
                    mediaItemId: row.mediaItemId,
                    altTextAsked: row.altTextAsked,
                  }
                : undefined;
            },
            describe: describeRow,
          }, { ai: aiCaptionsRef });
        }
      }
    } finally {
      workingRef.current = false;
    }
  }

  function handleFiles(list: FileList | File[] | null) {
    const picked = Array.from(list ?? []);
    setFileInputKey((key) => key + 1);
    if (picked.length === 0) return;
    const { take, tooMany: over } = filesThatFit(rowsRef.current.length, picked.length);
    setTooMany(over);
    const added = picked.slice(0, take).map((file) => {
      const row = newRow(file);
      filesRef.current.set(row.id, file);
      return row;
    });
    respread((current) => [...current, ...added]);
    void runWork();
  }

  function addMediaItems(picked: MediaItemDto[]) {
    const added = new Set(rowsRef.current.flatMap((row) => (row.mediaItemId ? [row.mediaItemId] : [])));
    const result = pickFromMedia({ rowCount: rowsRef.current.length, addedMediaIds: added, picked });
    setTooMany(result.tooMany);
    setDuplicateNote(result.duplicates);
    if (result.add.length === 0) return;
    const rowsToAdd = result.add.map(newMediaRow);
    respread((current) => [...current, ...rowsToAdd]);
    void runWork();
  }

  // Items handed over from the Media page become rows once the page is up.
  const startWithMedia = useEffectEvent(() => addMediaItems(initialMedia));
  useEffect(() => {
    if (initialMedia.length === 0) return;
    const timer = setTimeout(() => startWithMedia(), 0);
    return () => clearTimeout(timer);
  }, [initialMedia.length]);

  /** `byPerson` false: the page moved the default First day on by itself (tick). */
  function changeControls(patch: Partial<BulkScheduleControls>, byPerson = true) {
    const next = { ...controlsRef.current, ...patch };
    controlsRef.current = next;
    setControls(next);
    // R45 lead review: the person's change to the batch's schedule is an edit
    // to every row, so a row held for its refused time joins the spread.
    if (byPerson) timeHeldRef.current = new Set();
    respread();
  }

  function removeRow(id: string) {
    filesRef.current.delete(id);
    revokeThumbnail(id);
    setTooMany(false);
    dropTimeHold(id);
    respread((current) => current.filter((row) => row.id !== id));
  }

  function retryUpload(id: string) {
    updateRow(id, { upload: "queued", uploadError: null, uploadErrorKind: null });
    void runWork();
  }

  function writeAgain(id: string) {
    updateRow(id, { captionStatus: "waiting", captionOverwrite: true, captionError: null, improveError: null });
    void runWork();
  }

  // R45 publishing L1: both change whether the row holds a time.
  function markInQueue(id: string) {
    respread((current) =>
      current.map((row) => (row.id === id ? { ...row, ...confirmedInQueue(row), result: "In the Queue" } : row)),
    );
  }

  function sendAgain(id: string) {
    respread((current) => current.map((row) => (row.id === id ? { ...row, uncertain: false, uncertainMode: null } : row)));
  }

  // Feed, Story, or Feed and Story for the batch. Every row is one file, so the
  // one-file rule always holds; a video too long for a Story says so on its row.
  const stories = {
    instagram: selectedPlatforms.includes("instagram") && bulkStoryChoice(instagramPlacement.placement),
    facebook: selectedPlatforms.includes("facebook_page") && bulkStoryChoice(facebookPlacement.placement),
  };
  const googleShown = selectedPlatforms.includes("google_business_profile");
  const googleError = googleShown ? bulkGoogleMetadataError(googleMetadata) : null;
  const batchCheck: BulkBatchCheck = { selectedPlatforms, stories, googleError };
  // Once a row's check passes its press is over; a later edit that fails a
  // check again waits for the next press (React's set-state-while-rendering).
  const keptPresses = refusedPressesKept(refusedPresses, rows, batchCheck);
  if (keptPresses !== refusedPresses) setRefusedPresses(keptPresses);

  async function finish(mode: BulkFinishMode, pressed: HTMLElement | null) {
    if (sendingMode) return;
    setSendingMode(mode);
    try {
      const platformsOf = (row: BulkRow) => platformsForRow(selectedPlatforms, row.mimeType).platforms;
      // Checked first, against the clock at the press, so no row is sent while
      // another one still has a time in the past.
      const pressedAt = new Date();
      const ready: string[] = [];
      const refused = new Map<string, RefusedPress>();
      const timeHeld = new Set<string>();
      let altTooLong: string | null = null;
      for (const row of rowsToSend(rowsRef.current)) {
        const block = rowLocalBlock(row, mode, pressedAt, batchCheck);
        if (block) {
          refused.set(row.id, { mode, at: pressedAt.getTime() });
          updateRow(row.id, { sendError: null });
          if (block === SCHEDULED_TIME_TOO_SOON_MESSAGE) timeHeld.add(row.id);
          if (block === ALT_TEXT_TOO_LONG_TEXT) altTooLong ??= row.id;
        } else {
          ready.push(row.id);
        }
      }
      setRefusedPresses(refused);
      timeHeldRef.current = timeHeld;
      // R45 lead review: a description over its limit is the person's to
      // shorten, so the press takes them to the first one (rows in order).
      altFocusRef.current = altTooLong;

      // One after another. A created row, or one whose post may exist, is never sent again here.
      for (const id of ready) {
        const row = rowsRef.current.find((r) => r.id === id);
        if (!row || row.postId !== null || row.uncertain || !row.blob) continue;
        const platforms = platformsOf(row);
        const scheduledFor = mode === "schedule" ? localDateTimeToUtcIso(row.when) : null;
        if (mode === "schedule" && !scheduledFor) {
          updateRow(id, { sendError: BULK_NO_TIME_MESSAGE });
          continue;
        }
        updateRow(id, { sending: true, sendError: null });
        // As on Create: a frame whose image could not be had still goes as its
        // time (Instagram uses it); an uploaded cover that failed stops this row.
        let coverFields: ReturnType<typeof coverRequestFields> = {};
        if (row.mimeType.startsWith("video/") && row.cover.kind !== "default") {
          const { image, error: coverError } = await uploadCoverImage(row.cover, filesRef.current.get(id) ?? row.blob.url);
          if (row.cover.kind === "upload" && !image) {
            updateRow(id, { sending: false, sendError: coverError ?? BULK_COVER_FAILED_TEXT });
            continue;
          }
          coverFields = coverRequestFields(row.cover, image);
        }
        // A Media item is posted by id: the server reads it for this workspace only
        // and marks it used, so no client-sent address is trusted.
        const body = buildBulkRowBody({
          row: { ...row, blob: row.blob },
          platforms,
          deferred: scheduledFor ? { scheduledFor } : { draft: true },
          workspaceId,
          youtubePrivacy,
          googleMetadata,
          stories,
          coverFields,
        });
        let response: BulkSendResponse;
        try {
          const answer = await fetchOrNoAnswer("/api/posts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data: unknown = await answer.json().catch(() => UNREADABLE_BODY);
          response = { status: answer.status, body: data };
        } catch (error: unknown) {
          console.error("[Add many] Create request got no answer", error);
          response = { threw: true };
        }
        const result = classifySendResponse(response, mode);
        if (result.outcome === "created") {
          // R27 MM4: the last row created removes Schedule all; focus goes to Open the Queue.
          if (rowsRef.current.every((r) => r.id === id || r.postId !== null)) focusAfterPress(pressed, () => queueLinkRef.current);
          updateRow(id, {
            sending: false,
            // With a post id the row's time is locked (rowTimeLocked): it shows the
            // time sent. A draft holds none, so its row takes no place in the spreads.
            postId: result.postId,
            when: createdRowWhen(mode, row.when),
            result: bulkRowResultText({
              heldForApproval: result.heldForApproval,
              mode,
              body: "body" in response ? response.body : null,
            }),
          });
        } else if (result.outcome === "refused") {
          // R48 pages-a L1: the server's too-soon answer holds the row as the
          // press's own check does, so the time it names is the one shown.
          if (result.error === SCHEDULED_TIME_TOO_SOON_MESSAGE) timeHeldRef.current = new Set([...timeHeldRef.current, id]);
          updateRow(id, { sending: false, sendError: result.error });
        } else {
          updateRow(id, { sending: false, uncertain: true, uncertainMode: mode });
        }
      }
      // R44 publishing L1: a draft gave up its place (createdRowWhen), so the
      // rows still to send move up. Hand-set and created rows keep their times.
      respread();
    } finally {
      setSendingMode(null);
      if (altFocusRef.current) setAltFocusAsked((count) => count + 1);
    }
  }

  // On mount (the first fill) and every 30 s: move the inputs' `min` on, and the
  // default first day past midnight.
  const tick = useEffectEvent(() => {
    const current = new Date();
    setNow(current);
    const firstDay = refreshedFirstDay(
      { firstDay: controlsRef.current.firstDay, setByUser: firstDaySetByUserRef.current },
      current,
    );
    if (firstDay) changeControls({ firstDay }, false);
  });
  useEffect(() => {
    const first = setTimeout(() => tick(), 0);
    const timer = setInterval(() => tick(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  const workState = rows.map((r) => ({ id: r.id, upload: r.upload, caption: r.captionStatus }));
  const captionProgress = captionProgressText(workState);
  const uploadsPending = rows.some((r) => r.upload === "queued" || r.upload === "working");
  // An Improve or a photo description still to come is part of the caption work.
  const busy =
    uploadsPending || captionProgress !== null || rows.some((r) => r.improving || r.altTextWriting);
  const done = allRowsCreated(rows);
  const uploadingIndex = rows.findIndex((r) => r.upload === "working");

  // Full, or posts being created: no more files.
  const pickerLocked = rows.length >= BULK_MAX_FILES || sendingMode !== null;

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-4 p-4 md:p-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="bulk-files">Photos and videos</Label>
          {/* A drop area like Media's: a real file input stays inside its label
              (visually hidden, still focusable) for keyboard and screen readers. */}
          <div
            onDragOver={(event) => {
              // Always: otherwise a file dropped while full opens in the tab and the form is lost.
              event.preventDefault();
              if (!pickerLocked) setDragging(true);
            }}
            onDragLeave={(event) => {
              // Moving onto the icon or the label is still inside the area.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (pickerLocked) return;
              const dropped = splitDroppedFiles(Array.from(event.dataTransfer.files), "added");
              setDropNote(dropped.message);
              handleFiles(dropped.accepted);
            }}
            className={cn(
              "relative flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors focus-within:ring-2 focus-within:ring-ring",
              dragging ? "border-primary bg-primary/5" : "border-border",
              pickerLocked && "opacity-60",
            )}
          >
            <UploadCloud className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <input
              key={fileInputKey}
              id="bulk-files"
              type="file"
              multiple
              accept="video/*,image/*"
              disabled={pickerLocked}
              className="peer sr-only"
              onChange={(event) => {
                setDropNote(null);
                handleFiles(event.target.files);
              }}
            />
            <label
              htmlFor="bulk-files"
              className={cn(
                "inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                pickerLocked ? "cursor-not-allowed" : "cursor-pointer hover:bg-muted",
              )}
            >
              Choose photos and videos
            </label>
            <p className="text-xs text-muted-foreground">or drag them here</p>
          </div>
          {/* R30 pages A1: status lines are on the page from the first render; only their text changes. */}
          <p role="status" className="text-sm text-muted-foreground empty:sr-only">
            {dropNote}
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={pickerLocked}
              onClick={() => setPickerOpen(true)}
            >
              Choose from Media
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="bulk-ai-captions"
              type="checkbox"
              className="h-4 w-4 rounded border-input accent-[var(--primary)]"
              checked={aiCaptions}
              onChange={(event) => setAiCaptions(event.target.checked)}
            />
            <label htmlFor="bulk-ai-captions" className="text-sm text-foreground">Write captions with AI</label>
          </div>
          {!aiCaptions ? (
            <p className="text-sm text-muted-foreground">
              Off: your photos and videos are not sent to the AI. Write each caption yourself.
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {rows.length} of {BULK_MAX_FILES} added.
          </p>
          {skippedMediaMessage(skippedMedia) ? <Alert variant="warning">{skippedMediaMessage(skippedMedia)}</Alert> : null}
          {duplicateNote > 0 ? (
            <Alert variant="warning">
              {duplicateNote === 1 ? "1 item was" : `${duplicateNote} items were`} already added and left out.
            </Alert>
          ) : null}
          {tooMany ? <Alert variant="warning">{BULK_TOO_MANY_FILES_MESSAGE}</Alert> : null}
          <p className="text-sm text-muted-foreground empty:sr-only" aria-live="polite">
            {uploadingIndex >= 0 ? `Uploading ${uploadingIndex + 1} of ${rows.length}` : ""}
          </p>
          <p className="text-sm text-muted-foreground empty:sr-only" aria-live="polite">
            {captionProgress && aiCaptions ? captionProgress : ""}
          </p>
        </div>

        <BatchSettingsFieldset locked={sendingMode !== null}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-foreground">Post every row to</legend>
          {/* R41: a status line on the page from the first render, so Try again's focus goes to it while loading. */}
          <p role="status" className="text-sm text-muted-foreground empty:sr-only">
            {connectionsLoading && !connections ? "Loading your platforms..." : ""}
          </p>
          {connectionsLoading && !connections ? null : connectionsError ? (
            <Alert variant="danger">
              <LoadError message={connectionsError} onRetry={reload} retryLabel="Try again" layout="inline" />
            </Alert>
          ) : offeredPlatforms.length === 0 ? (
            <NoPlatformConnectedLine isMember={isMember} onlyTikTok={tiktokConnected} />
          ) : (
            <div className="flex flex-wrap gap-2">
              {offeredPlatforms.map((platform) => (
                <label
                  key={platform}
                  className="flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius)] border border-input px-3 text-sm"
                >
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={!deselected.has(platform)}
                    onChange={(event) =>
                      setDeselected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.delete(platform);
                        else next.add(platform);
                        return next;
                      })
                    }
                  />
                  {platformLabel(platform)}
                </label>
              ))}
            </div>
          )}
          <p className="text-sm text-muted-foreground">{BULK_TIKTOK_NOTE}</p>
          {youtubePrivacyShown(
            selectedPlatforms,
            rows.map((r) => r.mimeType),
          ) ? (
            <div className="flex flex-col gap-1 sm:max-w-xs">
              <Label htmlFor="bulk-youtube-privacy">YouTube privacy</Label>
              <Select
                id="bulk-youtube-privacy"
                className="h-11"
                value={youtubePrivacy}
                disabled={sendingMode !== null}
                onChange={(event) => setYoutubePrivacy(event.target.value as YouTubePostMetadata["privacyStatus"])}
              >
                <option value="public">Public</option>
                <option value="unlisted">Unlisted</option>
                <option value="private">Private</option>
              </Select>
            </div>
          ) : null}
          {selectedPlatforms.includes("instagram") ? (
            <StoryPlacementSettings
              platform="instagram"
              choice={instagramPlacement}
              fileCount={1}
              videoDurationSec={null}
              onChange={setInstagramPlacement}
            />
          ) : null}
          {selectedPlatforms.includes("facebook_page") ? (
            <StoryPlacementSettings
              platform="facebook_page"
              choice={facebookPlacement}
              fileCount={1}
              videoDurationSec={null}
              onChange={setFacebookPlacement}
            />
          ) : null}
          {googleShown ? (
            <div className="flex flex-col gap-2 sm:max-w-md">
              <div className="flex flex-col gap-1">
                <Label htmlFor="bulk-google-button">Google button</Label>
                <Select
                  id="bulk-google-button"
                  className="h-11"
                  value={googleMetadata.button?.type ?? ""}
                  disabled={sendingMode !== null}
                  onChange={(event) => {
                    const value = event.target.value as GoogleButtonType | "";
                    setGoogleMetadata(
                      !value
                        ? { postType: "update" }
                        : {
                            postType: "update",
                            button: value === "CALL" ? { type: value } : { type: value, url: googleMetadata.button?.url ?? "" },
                          },
                    );
                  }}
                >
                  <option value="">No button</option>
                  {GOOGLE_BUTTON_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {GOOGLE_BUTTON_LABELS[type]}
                    </option>
                  ))}
                </Select>
              </div>
              {googleMetadata.button && googleMetadata.button.type !== "CALL" ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="bulk-google-link">Button link</Label>
                  <Input
                    id="bulk-google-link"
                    type="url"
                    className="h-11"
                    placeholder="https://"
                    value={googleMetadata.button.url ?? ""}
                    disabled={sendingMode !== null}
                    onChange={(event) =>
                      setGoogleMetadata((current) =>
                        current.button ? { ...current, button: { ...current.button, url: event.target.value } } : current,
                      )
                    }
                  />
                </div>
              ) : null}
              {googleError ? <p className="text-sm text-destructive">{googleError}</p> : null}
              <p className="text-sm text-muted-foreground">
                Google photo posts go out as updates with this button. A video goes to your Google photos.
              </p>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-foreground">When</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="bulk-first-day">First day</Label>
              <Input
                id="bulk-first-day"
                type="date"
                disabled={useSlots}
                className="h-11"
                min={now ? minFirstDay(now) : undefined}
                value={controls.firstDay}
                onChange={(event) => {
                  firstDaySetByUserRef.current = true;
                  changeControls({ firstDay: event.target.value });
                }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bulk-time">Time of day</Label>
              <Input
                id="bulk-time"
                type="time"
                disabled={useSlots}
                className="h-11"
                value={controls.timeOfDay}
                onChange={(event) => changeControls({ timeOfDay: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="bulk-every">One every N days</Label>
              <Input
                id="bulk-every"
                type="number"
                disabled={useSlots}
                inputMode="numeric"
                min={1}
                step={1}
                className="h-11"
                value={everyDaysText}
                onChange={(event) => {
                  setEveryDaysText(event.target.value);
                  changeControls({ everyDays: Number(event.target.value) });
                }}
              />
            </div>
          </div>
          {slotData && slotData !== "error" ? (
            "refused" in slotData ? (
              <Alert variant="warning">{slotData.refused}</Alert>
            ) : slotData.slots.length > 0 ? (
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={useSlots}
                  disabled={sendingMode !== null}
                  onChange={(event) => changeUseSlots(event.target.checked)}
                />
                Use my posting times: each post gets the next free one, in order
              </label>
            ) : (
              <SetPostingTimesPrompt isMember={isMember} />
            )
          ) : null}
          <p className="text-sm text-muted-foreground">
            Times are in {zone ?? "your local time"}. A date you change by hand on a row stays as you set it.
          </p>
        </fieldset>
        </BatchSettingsFieldset>
      </Card>

      <MediaPickerDialog
        workspaceId={workspaceId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        addedIds={new Set(rows.flatMap((row) => (row.mediaItemId ? [row.mediaItemId] : [])))}
        room={Math.max(0, BULK_MAX_FILES - rows.length)}
        onAdd={addMediaItems}
      />

      {rows.length > 0 ? (
        <ol className="flex flex-col gap-4">
          {rows.map((row, index) => (
            <BulkPostRow
              key={row.id}
              row={row}
              index={index}
              count={rows.length}
              aiCaptions={aiCaptions}
              skipped={platformsForRow(selectedPlatforms, row.mimeType).skipped}
              locked={sendingMode !== null}
              minWhen={minRowTime(now ?? new Date())}
              storyRefusal={rowStoryRefusal({
                mimeType: row.mimeType,
                durationSec: row.durationSec,
                platforms: platformsForRow(selectedPlatforms, row.mimeType).platforms,
                stories,
              })}
              sendLine={rowSendLine(row, refusedPresses.get(row.id), batchCheck)}
              altFieldRef={(field) => {
                if (field) altFieldsRef.current.set(row.id, field);
                else altFieldsRef.current.delete(row.id);
              }}
              coverOpen={coverOpenId === row.id}
              onConfirmInQueue={() => markInQueue(row.id)}
              onSendAgain={() => sendAgain(row.id)}
              onCaptionChange={(caption) => {
                if (captionLocked(row)) return;
                // R41 publishing L1: typed text is never replaced by the
                // automatic caption, so its AI request goes; captionRow ends the
                // row's wait once its own media read is done.
                if (caption.trim() !== "") rowRequests.letGo(row.id, "caption");
                updateRow(row.id, { caption, sendError: null, improveError: null });
                releaseTimeHold(row.id);
              }}
              onAltTextChange={(altText) => {
                // R41 L1: an edit lets the description request go; the typed text stays.
                const letGo = rowRequests.letGo(row.id, "altText");
                updateRow(row.id, { altText, altTextError: null, ...(letGo ? { altTextWriting: false } : {}) });
                releaseTimeHold(row.id);
              }}
              onImprove={() => void improveRow(row.id)}
              onWriteDescription={() => void writeDescription(row.id)}
              onCoverOpenChange={(open) => setCoverOpenId(open ? row.id : null)}
              onCoverChange={(cover) => {
                updateRow(row.id, { cover, sendError: null });
                releaseTimeHold(row.id);
              }}
              onWhenChange={(when) => {
                updateRow(row.id, { when, whenSetByHand: true, sendError: null });
                // Set by hand now, so locked anyway: the hold just ends, and as
                // with any hand-set time the other rows stay where they are.
                dropTimeHold(row.id);
              }}
              onMove={(delta) => respread((current) => moveRow(current, row.id, delta))}
              onRemove={() => removeRow(row.id)}
              onRetry={() => retryUpload(row.id)}
              onWriteAgain={() => writeAgain(row.id)}
            />
          ))}
        </ol>
      ) : null}

      {rows.length > 0 && !done ? (
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            size="lg"
            className="w-full sm:w-auto"
            disabled={busy || sendingMode === "draft" || selectedPlatforms.length === 0}
            loading={sendingMode === "schedule"}
            onClick={(event) => void finish("schedule", event.currentTarget)}
          >
            Schedule all
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={busy || sendingMode === "schedule" || selectedPlatforms.length === 0}
            loading={sendingMode === "draft"}
            onClick={(event) => void finish("draft", event.currentTarget)}
          >
            Save all as drafts
          </Button>
          {busy ? (
            <p className="self-center text-sm text-muted-foreground">
              {/* R48 pages-a L4: with AI off a row is read, not captioned; "ready" is true either way. */}
              The buttons wait until every file is uploaded and ready.
            </p>
          ) : null}
        </div>
      ) : null}
      {rows.length > 0 && !done ? (
        <div className="-mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
          <p>{BULK_DRAFTS_NOTE}</p>
        </div>
      ) : null}

      {/* R27 pages L9: the region is on the page from the first render; only what is in it changes. */}
      <div role="status" className="empty:sr-only">
        {done ? (
          <Alert variant="success" role={undefined} title="Every post is created.">
            <Link ref={queueLinkRef} href="/queue" className={buttonVariants({ variant: "primary", size: "lg", className: "mt-2" })}>
              Open the Queue
            </Link>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
