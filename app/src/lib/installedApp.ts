/**
 * Whether this page runs as the installed app (display-mode standalone, or
 * iOS's navigator.standalone for a home-screen web app). On iOS the home-screen
 * app keeps a cookie store apart from Safari's, so a link that opens a new tab
 * lands in Safari without the session. Other platforms share the browser's
 * cookies, but their installed apps use the same view too, for
 * one consistent rule. No dependencies, so any component can use it (the
 * signed-out line, the Google sign-in link, Print card, the install entry).
 */
export function isInstalledApp(win: Window | undefined): boolean {
  return (
    !!win &&
    ((typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches) ||
      (win.navigator as Navigator & { standalone?: boolean } | undefined)?.standalone === true)
  );
}
