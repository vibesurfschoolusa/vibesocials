import { COVER_IMAGE_MAX_BYTES } from "./videoCover";

/** Wide enough for every platform's cover (YouTube asks for 1280 px or more), small enough to stay well under 8 MB. */
const COVER_MAX_WIDTH = 1920;
const COVER_JPEG_QUALITIES = [0.9, 0.75, 0.6] as const;
/** Give up (the cover is then sent as a frame time only) if the video can't be read in time. */
const CAPTURE_TIMEOUT_MS = 15_000;

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

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function grab(source: File | string, timeMs: number, video: HTMLVideoElement): Promise<File | null> {
  if (typeof source === "string") {
    // Another origin: without CORS the canvas is tainted and toBlob throws.
    video.crossOrigin = "anonymous";
    video.src = source;
  } else {
    video.src = URL.createObjectURL(source);
  }
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  await waitFor(video, "loadeddata");

  const seeked = waitFor(video, "seeked");
  video.currentTime = Math.min(timeMs / 1000, Number.isFinite(video.duration) ? video.duration : timeMs / 1000);
  await seeked;

  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return null;
  const width = Math.min(COVER_MAX_WIDTH, sourceWidth);
  const height = Math.round((width / sourceWidth) * sourceHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);

  for (const quality of COVER_JPEG_QUALITIES) {
    const blob = await toJpeg(canvas, quality);
    if (blob && blob.size > 0 && blob.size <= COVER_IMAGE_MAX_BYTES) {
      return new File([blob], "cover.jpg", { type: "image/jpeg" });
    }
  }
  return null;
}

/**
 * The video's frame at `timeMs` as a JPEG file, for the platforms that take a
 * cover image (YouTube, Facebook, LinkedIn). Browser only. Never throws: any
 * failure gives null, and the post then carries the frame time alone.
 */
export async function captureVideoFrame(source: File | string, timeMs: number): Promise<File | null> {
  const video = document.createElement("video");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      grab(source, timeMs, video),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (video.src.startsWith("blob:")) URL.revokeObjectURL(video.src);
    video.removeAttribute("src");
    video.load();
  }
}
