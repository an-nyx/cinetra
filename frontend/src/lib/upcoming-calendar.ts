import type { UpcomingRelease } from "../services/show.service";

/**
 * The release calendar shared by Upcoming and Home's "Coming soon" (one implementation, so both always agree).
 * Input is the TVMaze-only schedule from GET /show/upcoming. All day boundaries are the viewer's local calendar:
 * a confirmed air time is converted to local time; a date-only release keeps its date and never gets a time.
 */
export type CalendarFilter = "all" | "today" | "week" | "month" | "premieres";
export const calendarFilters: { id: CalendarFilter; label: string }[] = [
  { id: "all", label: "All Upcoming" }, { id: "today", label: "Today" }, { id: "week", label: "This Week" },
  { id: "month", label: "This Month" }, { id: "premieres", label: "Season Premieres" },
];

const pad = (value: number) => String(value).padStart(2, "0");
/** YYYY-MM-DD of a moment in the viewer's time zone. */
export const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** Local midnight of a YYYY-MM-DD day (no UTC parsing, so no off-by-one). */
export const parseDay = (key: string) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (key: string, days: number) => { const date = parseDay(key); date.setDate(date.getDate() + days); return dayKey(date); };
/** The local calendar day a release belongs to. */
export const releaseDay = (release: Pick<UpcomingRelease, "airTimestamp" | "airDate">) => release.airTimestamp ? dayKey(new Date(release.airTimestamp)) : release.airDate;

export type ReleaseEvent = {
  key: string; day: string; showId: string; showName: string; posterURL: string | null;
  episodes: UpcomingRelease[]; premiere: boolean; seriesPremiere: boolean;
  /** Earliest confirmed instant among the episodes; null when TVMaze gives only a date. */
  timestamp: string | null; channel: string | null; streaming: boolean;
};

/**
 * One event per show per local day: several new episodes of the same show released on the same day become one
 * card; episodes on other days stay on their own days. Entries are deduplicated by their stable TVMaze ID, and days
 * before the viewer's today are dropped. Grouping is by show identity only, never by title.
 */
export function groupReleaseEvents(releases: UpcomingRelease[], now: Date): ReleaseEvent[] {
  const today = dayKey(now);
  const unique = new Map<string, UpcomingRelease>();
  for (const release of releases) if (release && !unique.has(release.id)) unique.set(release.id, release);
  const events = new Map<string, ReleaseEvent>();
  for (const release of unique.values()) {
    const day = releaseDay(release);
    if (day < today) continue;
    const key = `${day}|${release.showId}`;
    const event = events.get(key) || { key, day, showId: release.showId, showName: release.showName, posterURL: release.posterURL, episodes: [], premiere: false, seriesPremiere: false, timestamp: null, channel: release.channel, streaming: release.streaming };
    event.episodes.push(release);
    events.set(key, event);
  }
  for (const event of events.values()) {
    event.episodes.sort((a, b) => a.season - b.season || a.number - b.number);
    event.premiere = event.episodes.some(e => e.seasonPremiere);
    event.seriesPremiere = event.episodes.some(e => e.season === 1 && e.number === 1);
    const times = event.episodes.flatMap(e => e.airTimestamp ? [e.airTimestamp] : []).sort();
    event.timestamp = times[0] || null;
  }
  // Date-only releases lead their day (no time is known), then confirmed times in order.
  return [...events.values()].sort((a, b) => a.day.localeCompare(b.day) || (a.timestamp ? Date.parse(a.timestamp) : 0) - (b.timestamp ? Date.parse(b.timestamp) : 0) || a.showName.localeCompare(b.showName));
}

/** Monday-to-Sunday week containing `now`, as [first day, day after last). */
export function weekBounds(now: Date) {
  const today = dayKey(now);
  const start = addDays(today, -((now.getDay() + 6) % 7));
  return [start, addDays(start, 7)] as const;
}

export function filterEvents(events: ReleaseEvent[], filter: CalendarFilter, now: Date) {
  const today = dayKey(now);
  if (filter === "all") return events;
  if (filter === "premieres") return events.filter(e => e.premiere);
  if (filter === "today") return events.filter(e => e.day === today);
  if (filter === "month") return events.filter(e => e.day.slice(0, 7) === today.slice(0, 7));
  const [start, end] = weekBounds(now);
  return events.filter(e => e.day >= start && e.day < end);
}

export function groupByDay(events: ReleaseEvent[]) {
  const days: { day: string; events: ReleaseEvent[] }[] = [];
  for (const event of events) {
    const last = days[days.length - 1];
    if (last && last.day === event.day) last.events.push(event); else days.push({ day: event.day, events: [event] });
  }
  return days;
}

/** "WEDNESDAY · NOV 11" */
export function dayHeading(day: string, locale?: string) {
  const date = parseDay(day);
  return `${date.toLocaleDateString(locale, { weekday: "long" })} · ${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}`.toLocaleUpperCase(locale);
}
/** "Today", "Tomorrow" or null. */
export function relativeDay(day: string, now: Date) {
  const today = dayKey(now);
  return day === today ? "Today" : day === addDays(today, 1) ? "Tomorrow" : null;
}
/** Compact date for Home: "Today", "Tomorrow" or "Wed, Nov 11". */
export const shortDay = (day: string, now: Date, locale?: string) => relativeDay(day, now) || parseDay(day).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
/** Local time of a confirmed air time, e.g. "9:00 PM"; null for date-only releases. */
export const timeLabel = (timestamp: string | null, locale?: string) => timestamp ? new Date(timestamp).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) : null;

export const episodeCode = (season: number, number: number) => `S${pad(season)}E${pad(number)}`;

/** "Episodes 1–4", "Episodes 2, 5" (numbers within one season). */
function numberRange(numbers: number[]) {
  const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  return consecutive ? `${numbers[0]}–${numbers[numbers.length - 1]}` : numbers.join(", ");
}

/**
 * The card's episode line. One episode: "S03E01 · Season 3 premiere". Several: "Season 3 premiere · Episodes 1–4"
 * or "Season 2 · Episodes 5–6".
 */
export function eventEpisodeLine(event: ReleaseEvent) {
  const eps = event.episodes;
  const premiereLabel = (season: number) => season === 1 ? "Series premiere" : `Season ${season} premiere`;
  if (eps.length === 1) {
    const e = eps[0];
    return e.seasonPremiere ? `${episodeCode(e.season, e.number)} · ${premiereLabel(e.season)}` : episodeCode(e.season, e.number);
  }
  const seasons = [...new Set(eps.map(e => e.season))];
  if (seasons.length > 1) return `Seasons ${seasons.join(", ")} · ${eps.length} episodes`;
  const season = seasons[0];
  const range = `Episodes ${numberRange(eps.map(e => e.number))}`;
  return event.premiere ? `${premiereLabel(season)} · ${range}` : `Season ${season} · ${range}`;
}

/** Header numbers for the visible schedule. */
export function calendarStats(events: ReleaseEvent[]) {
  return {
    episodes: events.reduce((n, e) => n + e.episodes.length, 0),
    shows: new Set(events.map(e => e.showId)).size,
    premieres: events.filter(e => e.premiere).length,
  };
}
