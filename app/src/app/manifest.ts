import type { MetadataRoute } from "next";

// Colours from the light theme in globals.css: --primary and --background.
// layout.tsx's `viewport` uses the same theme colour.
const THEME_COLOR = "#4f46e5";
const BACKGROUND_COLOR = "#ffffff";

/**
 * Served at /manifest.webmanifest. Makes the site installable on a phone, and
 * on Android registers it as a share target: a photo or video shared to the
 * app is caught by public/sw.js and opened on the Create page.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vibe Socials",
    short_name: "Vibe Socials",
    start_url: "/",
    display: "standalone",
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: { files: [{ name: "media", accept: ["image/*", "video/*"] }] },
    },
  };
}
