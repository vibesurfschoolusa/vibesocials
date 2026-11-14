"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";

type Section = { id: string; label: string };

/**
 * How far below the window's top a heading must reach to count as the section
 * in view: past the 4rem top bar, the link row below lg, and the headings'
 * scroll margin (8rem below lg), so a heading jumped to always counts.
 */
export const SECTION_LINE_PX = 160;

/**
 * The section in view: the last one whose heading has reached the line, the
 * first before any has, and the last at the bottom of the page, where a short
 * final section can never scroll up to the line.
 */
export function sectionInView(headings: Array<{ id: string; top: number }>, atBottom: boolean): string | null {
  if (headings.length === 0) return null;
  if (atBottom) return headings[headings.length - 1].id;
  let current = headings[0].id;
  for (const heading of headings) {
    if (heading.top <= SECTION_LINE_PX) current = heading.id;
  }
  return current;
}

/**
 * Where to scroll the link row (below lg it scrolls sideways) so the item
 * [itemLeft, itemLeft + itemWidth] is fully visible with a small margin; null
 * when it already is. Only the row moves, never the page.
 */
export function rowScrollToShow(
  item: { left: number; width: number },
  view: { scrollLeft: number; width: number },
  margin = 8,
): number | null {
  if (item.left - margin < view.scrollLeft) return Math.max(0, item.left - margin);
  if (item.left + item.width + margin > view.scrollLeft + view.width) {
    return item.left + item.width + margin - view.width;
  }
  return null;
}

export function SettingsSectionNav({ sections }: { sections: Section[] }) {
  const [currentId, setCurrentId] = useState<string | null>(sections[0]?.id ?? null);
  const listRef = useRef<HTMLUListElement>(null);

  // On a phone the row scrolls sideways; keep the marked link on screen.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !currentId || list.scrollWidth <= list.clientWidth) return;
    const item = Array.from(list.children).find(
      (child) => child.querySelector("a")?.getAttribute("href") === `#${currentId}`,
    ) as HTMLElement | undefined;
    if (!item) return;
    const next = rowScrollToShow(
      { left: item.offsetLeft - list.offsetLeft, width: item.offsetWidth },
      { scrollLeft: list.scrollLeft, width: list.clientWidth },
    );
    if (next !== null) list.scrollTo({ left: next, behavior: "smooth" });
  }, [currentId]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const headings = sections.flatMap(({ id }) => {
        const element = document.getElementById(id);
        return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
      });
      const atBottom =
        window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setCurrentId(sectionInView(headings, atBottom));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    // Landing on /settings#connections: mark it before the first scroll.
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sections]);

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-16 z-10 -mx-4 mb-6 border-b border-border bg-background/95 px-4 backdrop-blur md:-mx-6 md:px-6 lg:top-20 lg:mx-0 lg:mb-0 lg:self-start lg:border-b-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-none"
    >
      <ul ref={listRef} className="flex gap-1 overflow-x-auto py-2 text-sm lg:flex-col lg:overflow-visible lg:py-0">
        {sections.map((section) => {
          const current = section.id === currentId;
          return (
            <li key={section.id} className="shrink-0">
              <a
                href={`#${section.id}`}
                aria-current={current ? "location" : undefined}
                className={cn(
                  "block whitespace-nowrap rounded-[var(--radius)] px-3 py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  current
                    ? "bg-accent font-semibold text-foreground"
                    : "font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
