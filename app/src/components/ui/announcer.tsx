"use client";

import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { createAnnouncer, shouldAnnounce } from "@/lib/announcer";

interface Announcer {
  announce: (text: string) => void;
  /** False until the current page's first render is committed. */
  pageReady: () => boolean;
}

const AnnouncerContext = createContext<Announcer | null>(null);

/**
 * R30 PP2 (lead): one polite live region on every page (the root layout), on
 * the page from the first render. Alerts of a status variant and labelled
 * Spinners announce their text through it, so one that is added already
 * filled is still read out.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState("");
  const ready = useRef(false);
  const pathname = usePathname();
  const [announcer] = useState<Announcer>(() => ({
    announce: createAnnouncer(setText, (run) => window.setTimeout(run, 100), (handle) => window.clearTimeout(handle)),
    pageReady: () => ready.current,
  }));

  // Children's effects run before this one, and every cleanup before any of
  // them, so what a page renders first (on load or after a page change) is
  // not read out.
  useEffect(() => {
    ready.current = true;
    return () => {
      ready.current = false;
    };
  }, [pathname]);

  return (
    <AnnouncerContext.Provider value={announcer}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {text}
      </div>
    </AnnouncerContext.Provider>
  );
}

/** announce(text) for the page's region; does nothing without the provider. */
export function useAnnounce(): (text: string) => void {
  const announcer = useContext(AnnouncerContext);
  return announcer ? announcer.announce : noop;
}

function noop() {}

/**
 * Announces `read()` when the element mounts after the page's first render,
 * and whenever its text changes (shouldAnnounce). Checked after every render.
 */
export function useAnnounceOnShow(read: () => string, enabled: boolean): void {
  const announcer = useContext(AnnouncerContext);
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!announcer || !enabled) return;
    const text = read().replace(/\s+/g, " ").trim();
    const previous = last.current;
    last.current = text;
    if (shouldAnnounce({ pageReady: announcer.pageReady(), last: previous, text })) announcer.announce(text);
  });
}
