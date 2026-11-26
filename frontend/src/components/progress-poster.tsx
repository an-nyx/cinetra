import type { CSSProperties, ReactNode } from "react";
import { useProgressPosterPreference } from "@/lib/progress-poster-preference";

/**
 * Optional poster whose colour fills from the bottom up to the watched share of released episodes; the rest stays muted.
 * Pure CSS: two layers of the same image, one clipped. It is decoration only — the existing progress bar and its
 * accessible label stay the source of truth. Shown only when the user turns on Settings → Appearance → Progress Poster
 * (off by default); otherwise, and when progress is unknown, `original` — the untouched poster markup — is rendered.
 */
export default function ProgressPoster({ src, percent, className = "", original }: { src: string; percent: number | null; className?: string; original: ReactNode }) {
  const enabled = useProgressPosterPreference();
  const value = percent === null ? null : Math.max(0, Math.min(100, percent));
  if (!enabled || value === null) return <>{original}</>;
  return <span className={`progress-poster ${className}`} style={{ "--poster-progress": `${value}%` } as CSSProperties} data-complete={value >= 100 || undefined} data-empty={value <= 0 || undefined}>
    <img src={src} alt="" loading="lazy" decoding="async" className="progress-poster-base" />
    <img src={src} alt="" aria-hidden="true" loading="lazy" decoding="async" className="progress-poster-fill" />
    <span aria-hidden="true" className="progress-poster-edge" />
  </span>;
}
