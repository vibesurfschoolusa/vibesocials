/**
 * Whether this page runs as the installed app (display-mode standalone, or
 * iOS's navigator.standalone for a home-screen web app). The installed app
 * keeps its own cookies, apart from the browser's, so a link that opens a new
 * tab lands in the browser without the session. No dependencies, so any
 * component can use it (the signed-out line, the Google sign-in link).
 */
export function isInstalledApp(win: Window | undefined): boolean {
  return (
    !!win &&
    ((typeof win.matchMedia === "function" && win.matchMedia("(display-mode: standalone)").matches) ||
      (win.navigator as Navigator & { standalone?: boolean } | undefined)?.standalone === true)
  );
}
