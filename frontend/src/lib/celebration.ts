import type { EpisodeGuide, EpisodeSaveResult, TrackingSummary } from "../services/show.service";

/**
 * Presentation-only celebrations for confirmed episode saves. Nothing here reads or writes tracking data: milestones are
 * derived from the summary the save already returned (and the progress shown just before it), so no extra request is
 * made and no tracking rule changes. Only the screen that made the save celebrates; confirmed-summary broadcasts,
 * refreshes, background reconciliation and status changes never do.
 */
export type CelebrationLevel = "episode" | "season" | "caught_up" | "series";

/** Higher wins when milestones coincide or overlap. */
export const CELEBRATION_RANK: Record<CelebrationLevel, number> = { episode: 1, season: 2, caught_up: 3, series: 4 };

/** How long each level stays on screen (ms). Reduced motion uses the static durations. */
export const CELEBRATION_DURATION: Record<CelebrationLevel, number> = { episode: 480, season: 1400, caught_up: 1800, series: 2200 };
export const STATIC_CELEBRATION_DURATION: Record<CelebrationLevel, number> = { episode: 800, season: 2000, caught_up: 2200, series: 2600 };

export type CelebrationAnchor = { left: number; top: number; width: number; height: number };

export type Celebration = {
  level: CelebrationLevel;
  /** One save → one celebration: repeats of the same key inside the dedupe window are ignored. */
  key: string;
  showId: string;
  showName: string;
  season: number;
  anchor: CelebrationAnchor | null;
};

type Progress = Pick<TrackingSummary, "showId" | "viewingState">;

export type WatchMilestoneInput = {
  /** Progress shown before the save (the authoritative summary the action started from). */
  before: Progress | null;
  /** Confirmed progress returned by the save (or the follow-up read that existing flows already make). */
  after: Pick<TrackingSummary, "showId" | "viewingState"> | null;
  season: number;
  /** The episode just marked watched; null for "mark the released season watched". */
  episode: number | null;
  /** That season's confirmed guide after the save, when the response included it. */
  guideAfter: Pick<EpisodeGuide, "season" | "episodes"> | null;
  /** True when every episode of that season was already watched before the save (then it is not a new milestone). */
  seasonCompleteBefore?: boolean;
};

/** True when this save is what completed the whole season (every listed episode is now watched). Specials never count. */
export function completedSeason({ season, episode, guideAfter, seasonCompleteBefore }: WatchMilestoneInput): boolean {
  if (seasonCompleteBefore || season <= 0 || !guideAfter || guideAfter.season !== season || !guideAfter.episodes.length) return false;
  if (episode !== null && !guideAfter.episodes.some(e => e.number === episode)) return false;
  return guideAfter.episodes.every(e => e.watched);
}

/**
 * The single highest milestone this save reached. Series and caught-up need a real transition of the server's
 * metadata-derived viewing state (`fully_watched` already requires a verified, finished series with every regular
 * episode watched; `caught_up` an ongoing one with every released episode watched). The personal status (e.g. a
 * manually chosen Completed) is never consulted.
 */
export function classifyWatchMilestone(input: WatchMilestoneInput): CelebrationLevel {
  const { before, after } = input;
  if (before && after && before.showId === after.showId && before.viewingState !== after.viewingState) {
    if (after.viewingState === "fully_watched") return "series";
    if (after.viewingState === "caught_up") return "caught_up";
  }
  return completedSeason(input) ? "season" : "episode";
}

/**
 * Admission control shared by every screen: ignores repeats of the same save key, and never lets a smaller celebration
 * cut short a bigger one still on screen. A bigger (or equal) one replaces whatever is showing.
 */
export function createCelebrationGate({ dedupeMs = 5000, now = () => Date.now() } = {}) {
  const seen = new Map<string, number>();
  let active: { rank: number; until: number } | null = null;
  return {
    admit(celebration: Pick<Celebration, "key" | "level">, duration: number): boolean {
      const time = now();
      for (const [key, at] of seen) if (time - at >= dedupeMs) seen.delete(key);
      if (seen.has(celebration.key)) return false;
      const rank = CELEBRATION_RANK[celebration.level];
      if (active && time < active.until && rank < active.rank) return false;
      seen.set(celebration.key, time);
      active = { rank, until: time + duration };
      return true;
    },
    /** The current celebration ended early (unmount, preference turned off). */
    clear() { active = null; },
  };
}

export const CELEBRATION_EVENT = "cinetra:celebration";

export function requestCelebration(celebration: Celebration) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<Celebration>(CELEBRATION_EVENT, { detail: celebration }));
}

export function onCelebration(listener: (celebration: Celebration) => void) {
  const handler = (event: Event) => { const detail = (event as CustomEvent<Celebration>).detail; if (detail?.level) listener(detail); };
  window.addEventListener(CELEBRATION_EVENT, handler);
  return () => window.removeEventListener(CELEBRATION_EVENT, handler);
}

/**
 * Where the episode check appears: the tapped control's icon when it has one (otherwise the control), measured at tap
 * time — where the finger was — because the control may change ("Updating…") or disappear before the save ends.
 */
export function celebrationAnchor(control: Element | null | undefined): CelebrationAnchor | null {
  if (!control) return null;
  const box = (control.querySelector("svg") ?? control).getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

/**
 * Celebrate one confirmed "watched" save. Call only from a save's success path, never for unwatching, failures,
 * refreshes or broadcasts.
 */
export function celebrateWatch(input: WatchMilestoneInput & { showId: string; showName: string; anchor: CelebrationAnchor | null }) {
  const level = classifyWatchMilestone(input);
  requestCelebration({
    level, showId: input.showId, showName: input.showName, season: input.season, anchor: input.anchor,
    key: `${input.showId}:${input.season}:${input.episode ?? "season"}`,
  });
}

/**
 * Celebrate a confirmed "mark next episode watched" save from a list (Home, Continue watching, Shows). `before` is the
 * row the user acted on, so the episode was unwatched and the season was not yet complete.
 */
export function celebrateNextEpisodeSave(before: TrackingSummary, episode: { season: number; number: number }, result: unknown, anchor: CelebrationAnchor | null) {
  const saved = result as Partial<EpisodeSaveResult> | null | undefined;
  const after = saved?.summary && saved.summary.showId === before.showId ? saved.summary : null;
  celebrateWatch({
    before, after, season: episode.season, episode: episode.number, guideAfter: after ? saved?.guide ?? null : null,
    showId: before.showId, showName: after?.name || before.name, anchor,
  });
}
