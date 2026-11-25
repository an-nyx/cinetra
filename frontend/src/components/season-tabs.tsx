import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { T, phrase, useLanguage } from "@/i18n";
import { useSlidingIndicator } from "@/hooks/use-sliding-indicator";

/** Scrolls only the horizontal season rail (never the dialog) so `target` is fully visible. */
function revealInRail(scroller: HTMLElement, target: HTMLElement) {
  const rail = scroller.getBoundingClientRect(), item = target.getBoundingClientRect(), margin = 12;
  const delta = item.left < rail.left + margin ? item.left - rail.left - margin : item.right > rail.right - margin ? item.right - rail.right + margin : 0;
  if (!delta) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  scroller.scrollBy({ left: delta, behavior: reduce ? "auto" : "smooth" });
}

/**
 * Season tabs with one sliding mint pill. Same choices and actions as before: activating a tab loads that season.
 * Keyboard: one tab stop; arrow keys move focus (mirrored in Arabic), Home/End jump; Enter or Space opens a season.
 */
export default function SeasonTabs({ seasons, season, busy, onSelect }: { seasons: { number: number; episodeCount: number }[]; season: number; busy: boolean; onSelect: (season: number) => void }) {
  const { language } = useLanguage();
  const scroller = useRef<HTMLDivElement>(null);
  const { track, indicator } = useSlidingIndicator<HTMLDivElement>(`${season}:${seasons.length}:${language}`);

  // Keep the selected season visible, e.g. when the dialog opens on season 7 of 9.
  useLayoutEffect(() => {
    const active = track.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (scroller.current && active) revealInRail(scroller.current, active);
  }, [season, seasons.length, track]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...(track.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') || [])];
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (!tabs.length || current < 0) return;
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    const next = step ? (current + step + tabs.length) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    tabs[next].focus({ preventScroll: true });
    if (scroller.current) revealInRail(scroller.current, tabs[next]);
  };

  return <div ref={scroller} className="segmented-scroller -mx-1 -mt-1 px-1 pb-2 pt-1">
    {/* Seasons as tappable pills: one tap, no picker. Scrolls sideways for long-running shows. */}
    <div ref={track} role="tablist" aria-label={phrase(language, "Season")} onKeyDown={onKeyDown} className="segmented-track is-solid">
      <span ref={indicator} className="segmented-indicator" aria-hidden="true" />
      {seasons.map(item => <button key={item.number} type="button" role="tab" aria-selected={item.number === season} data-active={item.number === season} tabIndex={item.number === season ? 0 : -1} disabled={busy} onClick={() => onSelect(item.number)} className="segmented-option px-4 text-sm font-medium"><T>Season</T> {item.number}<span className="sr-only"> · {item.episodeCount} {phrase(language, "Episodes")}</span></button>)}
    </div>
  </div>;
}
