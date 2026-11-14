/**
 * Small pure helpers for the pages a client opens from a link (/u, /v, /c):
 * the workspace's initials for the header tile, and the upload page's file list.
 */

export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (words.length === 0) return "?";
  // Array.from so an emoji or other surrogate pair counts as one character.
  return words.map((word) => Array.from(word)[0].toUpperCase()).join("");
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
