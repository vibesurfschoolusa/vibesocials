"use client";

import { useEffect } from "react";

/**
 * Registers public/sw.js, which only receives files shared to the installed
 * app on Android. Without it the app still works, so a browser that refuses
 * it (no support, private mode) is left alone.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
