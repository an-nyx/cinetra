import type { CSSProperties } from "react";

/**
 * Visual prototype (under review): a poster whose colour fills from the bottom up to the watched share of released
 * episodes; the rest stays muted. Pure CSS: two layers of the same image, one clipped. It is decoration only —
 * the existing progress bar and its accessible label stay the source of truth. Set to false to remove it everywhere.
 */
export const PROGRESS_POSTER_ENABLED = true;

export default function ProgressPoster({ src, percent, className = "" }: { src: string; percent: number | null; className?: string }) {
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  if (!PROGRESS_POSTER_ENABLED || value === null) {
    return <img src={src} alt="" loading="lazy" decoding="async" className={`object-cover ${className}`} />;
  }
  return <span className={`progress-poster ${className}`} style={{ "--poster-progress": `${value}%` } as CSSProperties} data-complete={value >= 100 || undefined} data-empty={value <= 0 || undefined}>
    <img src={src} alt="" loading="lazy" decoding="async" className="progress-poster-base" />
    <img src={src} alt="" aria-hidden="true" loading="lazy" decoding="async" className="progress-poster-fill" />
    <span aria-hidden="true" className="progress-poster-edge" />
  </span>;
}
