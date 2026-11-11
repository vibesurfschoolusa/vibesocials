import { existsSync, readFileSync } from "node:fs";

import type { Browser } from "@playwright/test";

/**
 * UI audit: the made-up photos and the video the screens use. Photos are drawn
 * on a canvas in the test browser (no image library needed); the video is the
 * file the workflow made with ffmpeg (UI_AUDIT_VIDEO), or, when that is
 * missing, a short WebM recorded from a canvas in the browser.
 */

export interface AuditFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const PHOTO_SCENES: { label: string; sub: string; hue: number }[] = [
  { label: "Saturday lesson", sub: "Cocoa Beach, 8 am", hue: 195 },
  { label: "New boards in", sub: "9'0\" soft tops", hue: 28 },
  { label: "Kids camp", sub: "Week 2 photos", hue: 160 },
  { label: "Sunrise session", sub: "Glassy and small", hue: 12 },
  { label: "Wax and fins", sub: "Shop corner", hue: 270 },
  { label: "Team photo", sub: "Harbor Surf Co", hue: 210 },
  { label: "Board rental", sub: "By the hour", hue: 95 },
  { label: "Low tide walk", sub: "Before the lesson", hue: 45 },
  { label: "Surf check", sub: "2-3 ft, offshore", hue: 185 },
  { label: "Gift cards", sub: "Any amount", hue: 330 },
];

export async function makePhotos(browser: Browser, count: number, width = 1080, height = 1080): Promise<AuditFile[]> {
  const page = await browser.newPage();
  try {
    const scenes = Array.from({ length: count }, (_, i) => PHOTO_SCENES[i % PHOTO_SCENES.length]);
    const encoded = await page.evaluate(
      ({ scenes, width, height }) =>
        scenes.map(({ label, sub, hue }) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const g = canvas.getContext("2d")!;
          const sky = g.createLinearGradient(0, 0, 0, height);
          sky.addColorStop(0, `hsl(${hue}, 70%, 62%)`);
          sky.addColorStop(0.55, `hsl(${(hue + 25) % 360}, 65%, 45%)`);
          sky.addColorStop(1, `hsl(${(hue + 50) % 360}, 60%, 28%)`);
          g.fillStyle = sky;
          g.fillRect(0, 0, width, height);
          g.fillStyle = "rgba(255, 236, 170, 0.85)";
          g.beginPath();
          g.arc(width * 0.78, height * 0.24, width * 0.09, 0, Math.PI * 2);
          g.fill();
          for (let i = 0; i < 6; i++) {
            g.strokeStyle = `rgba(255, 255, 255, ${0.25 + i * 0.08})`;
            g.lineWidth = Math.max(4, width / 140);
            g.beginPath();
            for (let x = 0; x <= width; x += 12) {
              const y = height * 0.52 + i * (height / 16) + Math.sin(x / (width / 14) + i * 1.3) * (height / 60);
              if (x === 0) g.moveTo(x, y);
              else g.lineTo(x, y);
            }
            g.stroke();
          }
          g.fillStyle = "rgba(0, 0, 0, 0.35)";
          g.fillRect(0, height * 0.06, width, height * 0.2);
          g.fillStyle = "#ffffff";
          g.font = `bold ${Math.round(width / 13)}px sans-serif`;
          g.fillText(label, width * 0.06, height * 0.15);
          g.font = `${Math.round(width / 26)}px sans-serif`;
          g.fillText(sub, width * 0.06, height * 0.22);
          return canvas.toDataURL("image/jpeg", 0.82).split(",")[1];
        }),
      { scenes, width, height },
    );
    return encoded.map((base64, i) => ({
      name: `harbor-surf-${String(i + 1).padStart(2, "0")}-${scenes[i].label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.jpg`,
      mimeType: "image/jpeg",
      buffer: Buffer.from(base64, "base64"),
    }));
  } finally {
    await page.close();
  }
}

export async function makeLogo(browser: Browser): Promise<AuditFile> {
  const page = await browser.newPage();
  try {
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 480;
      canvas.height = 160;
      const g = canvas.getContext("2d")!;
      g.fillStyle = "#0e7490";
      g.beginPath();
      g.arc(80, 80, 64, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#ffffff";
      g.lineWidth = 10;
      g.beginPath();
      for (let x = 24; x <= 136; x += 4) {
        const y = 88 + Math.sin(x / 12) * 10;
        if (x === 24) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.fillStyle = "#0f172a";
      g.font = "bold 44px sans-serif";
      g.fillText("Harbor Surf", 164, 78);
      g.font = "28px sans-serif";
      g.fillText("Co", 164, 118);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    return { name: "harbor-surf-logo.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") };
  } finally {
    await page.close();
  }
}

/** The ffmpeg-made MP4 when the workflow provided one, else a recorded WebM. */
export async function makeVideo(browser: Browser): Promise<AuditFile | null> {
  const fromWorkflow = process.env.UI_AUDIT_VIDEO;
  if (fromWorkflow && existsSync(fromWorkflow)) {
    return { name: "harbor-surf-lesson-clip.mp4", mimeType: "video/mp4", buffer: readFileSync(fromWorkflow) };
  }
  const page = await browser.newPage();
  try {
    const base64 = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 540;
      canvas.height = 960;
      document.body.appendChild(canvas);
      const g = canvas.getContext("2d")!;
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });
      recorder.start(200);
      const started = performance.now();
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const t = (performance.now() - started) / 1000;
          g.fillStyle = `hsl(${(195 + t * 20) % 360}, 65%, 45%)`;
          g.fillRect(0, 0, 540, 960);
          g.fillStyle = "#ffffff";
          g.font = "bold 48px sans-serif";
          g.fillText("Harbor Surf Co", 40, 120);
          g.fillRect(40 + ((t * 120) % 400), 600 + Math.sin(t * 3) * 40, 80, 20);
          if (t > 4) {
            clearInterval(timer);
            resolve();
          }
        }, 33);
      });
      recorder.stop();
      await stopped;
      const bytes = new Uint8Array(await new Blob(chunks, { type: "video/webm" }).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    });
    return { name: "harbor-surf-lesson-clip.webm", mimeType: "video/webm", buffer: Buffer.from(base64, "base64") };
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

/** PUTs a file into the audit's file store double and returns the address it is served from. */
export async function putIntoStore(pathname: string, file: AuditFile): Promise<string> {
  const base = process.env.VERCEL_BLOB_API_URL ?? "http://localhost:9366";
  const response = await fetch(`${base}/?pathname=${encodeURIComponent(pathname)}`, {
    method: "PUT",
    headers: { "x-content-type": file.mimeType, "content-type": file.mimeType },
    body: new Uint8Array(file.buffer),
  });
  if (!response.ok) throw new Error(`file store refused ${pathname}: ${response.status}`);
  const body = (await response.json()) as { url: string };
  return body.url;
}
