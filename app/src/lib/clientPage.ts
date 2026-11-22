/**
 * Small pure helpers for the pages a client opens from a link (/u, /v, /c):
 * the workspace's initials for the header tile, and the upload page's file list.
 */

import { truncateGraphemes, truncateGraphemesWithinCodePoints } from "@/lib/truncate";

/**
 * The longest first grapheme an initial keeps whole: the longest standard
 * (RGI) emoji, the kiss with two skin tones, is 10 code points (R67).
 */
const INITIAL_MAX_CODE_POINTS = 10;

export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return "?";
  return words.map((word) => initialOf(word).toUpperCase()).join("");
}

/**
 * R66: the word's first grapheme, so an emoji, a flag or a skin tone stays
 * whole. A grapheme over 10 code points (a letter with many marks) gives its
 * first code point instead: the base letter, never half a surrogate pair.
 */
function initialOf(word: string): string {
  const first = truncateGraphemes(word, 1);
  if (truncateGraphemesWithinCodePoints(first, INITIAL_MAX_CODE_POINTS) === first) return first;
  return String.fromCodePoint(word.codePointAt(0) ?? 0x3f);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole KB, one decimal above that.
  const text = unit === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return `${text} ${units[unit]}`;
}

const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i;

/** Some phones give a video no type, so the name decides then. */
export function fileKind(file: { name: string; type: string }): "photo" | "video" {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "photo";
  return VIDEO_EXTENSION.test(file.name) ? "video" : "photo";
}

export type FileStatus = "waiting" | "sending" | "sent" | "failed";

export interface PickedFile {
  key: string;
  file: File;
  status: FileStatus;
  progress: number;
  error: string | null;
}

function keyOf(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

/** The list after a pick: new files added at the end, a file already listed not added twice. */
export function addPickedFiles(existing: PickedFile[], incoming: File[]): PickedFile[] {
  const seen = new Set(existing.map((item) => item.key));
  const added: PickedFile[] = [];
  for (const file of incoming) {
    const key = keyOf(file);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push({ key, file, status: "waiting", progress: 0, error: null });
  }
  return [...existing, ...added];
}

/**
 * A drop on the client upload page: photos and videos are kept (and files the
 * browser gives no type, such as some iPhone photos, which the upload checks);
 * anything else is left out, with a sentence saying how many, instead of
 * vanishing without a word.
 */
export function splitDroppedFiles(
  files: File[],
  verb: "sent" | "added" = "sent",
): { accepted: File[]; leftOut: number; message: string | null } {
  const accepted = files.filter(
    (file) => file.type === "" || file.type.startsWith("image/") || file.type.startsWith("video/"),
  );
  const leftOut = files.length - accepted.length;
  const message =
    leftOut === 0
      ? null
      : `${leftOut} ${leftOut === 1 ? "file was" : "files were"} left out: only photos and videos can be ${verb}.`;
  return { accepted, leftOut, message };
}
