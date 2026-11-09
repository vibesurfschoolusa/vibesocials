import { MAX_VIDEO_FRAMES, videoFrameTimes } from "./videoFrames";

/** Frame width sent to the caption AI: enough to read on-screen text. */
const FRAME_MAX_WIDTH = 512;
const FRAME_JPEG_QUALITY = 0.7;
/** Give up (and caption without frames) if the video can't be read in time. */
const EXTRACT_TIMEOUT_MS = 10_000;

function waitFor(video: HTMLVideoElement, event: "loadeddata" | "seeked"): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener(event, done);
      video.removeEventListener("error", failed);
      resolve();
    };
    const failed = () => {
      video.removeEventListener(event, done);
      video.removeEventListener("error", failed);
      reject(new Error("The video could not be read"));
    };
    video.addEventListener(event, done);
    video.addEventListener("error", failed);
  });
}

async function grabFrames(source: File | string, video: HTMLVideoElement): Promise<string[]> {
  if (typeof source === "string") {
    // An uploaded file on another origin: without CORS the canvas is tainted and
    // toDataURL throws, which the caller turns into "no frames".
    video.crossOrigin = "anonymous";
    video.src = source;
  } else {
    video.src = URL.createObjectURL(source);
  }
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await waitFor(video, "loadeddata");

  const sourceWidth = video.videoWidth || FRAME_MAX_WIDTH;
  const sourceHeight = video.videoHeight || sourceWidth;
  const width = Math.min(FRAME_MAX_WIDTH, sourceWidth);
  const height = Math.round((width / sourceWidth) * sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return [];

  const frames: string[] = [];
  for (const time of videoFrameTimes(video.duration).slice(0, MAX_VIDEO_FRAMES)) {
    const seeked = waitFor(video, "seeked");
    video.currentTime = time;
    await seeked;
    context.drawImage(video, 0, 0, width, height);
    frames.push(canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY));
  }
  return frames;
}

/**
 * Up to 3 small JPEG frames (data URLs) from a video, for the AI caption.
 * Browser only. Never throws: any failure (an unreadable file, a tainted canvas
 * or the 10 s limit) gives [], and the caption is then written without them.
 */
export async function extractVideoFrames(source: File | string): Promise<string[]> {
  const video = document.createElement("video");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      grabFrames(source, video),
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), EXTRACT_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
    video.removeAttribute("src");
    video.load();
  }
}
