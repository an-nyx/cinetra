import type { ReleaseEvent } from "./upcoming-calendar.ts";

/**
 * Countdown to the next release (display only). It reads the verified instants the schedule already carries and
 * never decides availability: reaching zero only hides the countdown; Home, Upcoming and the Watch Room keep
 * following the server's release rule.
 */
export const COUNTDOWN_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Only instants Cinetra itself releases at: a verified TVMaze premiere or a documented manual time. */
const VERIFIED_SOURCES = new Set(["tvmaze_exact", "manual_override"]);
export function verifiedReleaseInstant(event: Pick<ReleaseEvent, "episodes">): string | null {
  const instants = event.episodes
    .filter(episode => episode.releaseAt && episode.releaseSource && VERIFIED_SOURCES.has(episode.releaseSource))
    .map(episode => episode.releaseAt as string)
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort();
  return instants[0] ?? null;
}

/**
 * The single next release that gets a countdown: the earliest verified instant still in the future and at most
 * `horizon` away. Date-only, estimated (fallback) and unverified TVMaze air times never qualify.
 */
export function nextCountdown(events: Pick<ReleaseEvent, "key" | "episodes">[], now: Date, horizon = COUNTDOWN_HORIZON_MS): { key: string; at: number } | null {
  const start = now.getTime();
  let best: { key: string; at: number } | null = null;
  for (const event of events) {
    const instant = verifiedReleaseInstant(event);
    if (!instant) continue;
    const at = Date.parse(instant);
    if (at <= start || at - start > horizon) continue;
    if (!best || at < best.at) best = { key: event.key, at };
  }
  return best;
}

/** Whole units left. Above one hour the countdown shows hours and minutes (rounded up); below, minutes and seconds. */
export function countdownParts(remainingMs: number) {
  const remaining = Math.max(0, remainingMs);
  if (remaining >= 60 * 60 * 1000) {
    const totalMinutes = Math.ceil(remaining / 60_000);
    return { precise: false as const, hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60, seconds: 0 };
  }
  const totalSeconds = Math.ceil(remaining / 1000);
  return { precise: true as const, hours: 0, minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

/** Milliseconds until the visible value next changes: once a minute above one hour, once a second below. */
export function nextTickDelay(remainingMs: number) {
  if (remainingMs <= 0) return null;
  const unit = remainingMs > 60 * 60 * 1000 ? 60_000 : 1000;
  const delay = remainingMs % unit;
  return delay === 0 ? unit : delay;
}
