import { useLayoutEffect, useRef } from "react";

/**
 * Places one indicator under the active option of a segmented group (`[data-active="true"]` inside the track) and
 * lets CSS slide it between options. The track must be `position: relative`; the indicator is positioned from the
 * track's physical left edge, so it lands correctly in both LTR and RTL. Only transform and width change.
 * The first placement is instant (no slide in from the edge); later changes transition unless reduced motion is on.
 */
export function useSlidingIndicator<T extends HTMLElement = HTMLDivElement>(activeKey: unknown) {
  const track = useRef<T>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = track.current, mark = indicator.current;
    if (!element || !mark) return;
    const place = () => {
      const active = element.querySelector<HTMLElement>('[data-active="true"]');
      if (!active) { mark.style.opacity = "0"; return; }
      mark.style.opacity = "1";
      mark.style.width = `${active.offsetWidth}px`;
      mark.style.transform = `translateX(${active.offsetLeft}px)`;
    };
    place();
    // Enable the transition only after the first placement has been painted.
    const frame = requestAnimationFrame(() => { mark.dataset.ready = "true"; });
    // Labels change width with the language or once fonts load: follow without animating from a stale spot.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    observer?.observe(element);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [activeKey]);
  return { track, indicator };
}
