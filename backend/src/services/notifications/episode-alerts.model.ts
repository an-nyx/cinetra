/**
 * New-episode notification rules (pure, no network, no database).
 *
 * TVMaze is the only source of premiere dates; TMDB stays the canonical show identity and the user's saved tracking
 * is only ever read. Everything here decides *whether* a device should hear about an episode; delivery and
 * de-duplication live in the notifier service.
 */
import type { TVMazeEpisode, TVMazeShow } from '../tvmaze/tvmaze-schedule.model';

export const EPISODE_PREMIERE_EVENT = 'episode_premiere';
/** Premieres older than this are never announced (e.g. after server downtime): late alerts would just be noise. */
export const NOTIFY_LOOKBACK_MS = 48 * 60 * 60_000;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Offset (ms) of an IANA time zone from UTC at a given instant, or null for an unknown zone. */
function zoneOffset(timeZone: string, at: number): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(at / 1000) * 1000;
  } catch { return null; }
}

/** UTC instant of 00:00 local time on `date` (YYYY-MM-DD) in `timeZone`; DST-safe. Null for an unknown zone. */
export function zonedMidnight(date: string, timeZone: string): Date | null {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const offset = zoneOffset(timeZone, guess);
    if (offset === null) return null;
    const next = wall - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export type PremiereTiming = 'exact' | 'date_only_local' | 'date_only_worldwide';
/**
 * When an episode has certainly premiered.
 *
 * - TVMaze lists an air time and a UTC airstamp: that instant.
 * - Date only (common for streaming drops): TVMaze does not say when on that day it releases, so no time is invented.
 *   The episode counts as premiered once its listed day has *ended* in the channel's time zone (local midnight
 *   that follows). When TVMaze gives no time zone, the day must have ended everywhere on Earth (UTC-12, "anywhere on
 *   Earth"): 12:00 UTC on the following day. Late, but never early.
 */
export function premiereInstant(episode: Pick<TVMazeEpisode, 'airdate' | 'airtime' | 'airstamp'>, timeZone: string | null | undefined): { at: Date; timing: PremiereTiming } | null {
  if (!episode.airdate || !DATE.test(episode.airdate)) return null;
  if (episode.airtime && TIME.test(episode.airtime) && episode.airstamp && !Number.isNaN(Date.parse(episode.airstamp))) {
    return { at: new Date(episode.airstamp), timing: 'exact' };
  }
  const following = nextDay(episode.airdate);
  const local = timeZone ? zonedMidnight(following, timeZone) : null;
  if (local) return { at: local, timing: 'date_only_local' };
  return { at: new Date(`${following}T12:00:00Z`), timing: 'date_only_worldwide' };
}

/** The time zone TVMaze's local dates refer to: the broadcast network's, else the web channel's (often absent). */
export const scheduleTimeZone = (show: Pick<TVMazeShow, 'network' | 'webChannel'>) =>
  show.network?.country?.timezone || show.webChannel?.country?.timezone || null;

export type PremieredEpisode = { tvmazeEpisodeId: number; season: number; number: number; premieredAt: Date; timing: PremiereTiming };
export type PremiereExclusions = { specials: number; undated: number; duplicates: number; repeats: number; notYet: number; tooOld: number };

/**
 * Regular episodes that premiered in [since, now]. From the per-show episode list (never broadcast schedule feeds,
 * which also list reruns):
 * - the same TVMaze episode ID counts once (duplicate provider records);
 * - a second record for a season/episode number already listed is a repeat; the earliest premiere wins, so a
 *   rebroadcast of an episode that premiered earlier is never "new";
 * - specials (non-"regular" types, season 0, unnumbered) and undated/rumoured entries are excluded;
 * - not-yet-premiered episodes (by the conservative instant above) and premieres before `since` are excluded.
 */
export function selectPremieredEpisodes(episodes: TVMazeEpisode[], window: { since: Date; now: Date }, timeZone: string | null): { episodes: PremieredEpisode[]; excluded: PremiereExclusions } {
  const excluded: PremiereExclusions = { specials: 0, undated: 0, duplicates: 0, repeats: 0, notYet: 0, tooOld: 0 };
  const dated = (e: TVMazeEpisode) => (e.airdate && DATE.test(e.airdate) ? e.airdate : '9999-99-99');
  const ordered = [...episodes].sort((a, b) => dated(a).localeCompare(dated(b)) || a.id - b.id);
  const seenIds = new Set<number>();
  const seenNumbers = new Set<string>();
  const selected: PremieredEpisode[] = [];
  for (const episode of ordered) {
    if (seenIds.has(episode.id)) { excluded.duplicates++; continue; }
    seenIds.add(episode.id);
    const season = episode.season ?? 0;
    const number = episode.number ?? 0;
    if ((episode.type && episode.type !== 'regular') || !Number.isInteger(season) || season < 1 || !Number.isInteger(number) || number < 1) { excluded.specials++; continue; }
    const key = `${season}:${number}`;
    const repeat = seenNumbers.has(key);
    seenNumbers.add(key);
    if (repeat) { excluded.repeats++; continue; }
    const premiere = premiereInstant(episode, timeZone);
    if (!premiere) { excluded.undated++; continue; }
    if (premiere.at.getTime() > window.now.getTime()) { excluded.notYet++; continue; }
    if (premiere.at.getTime() < window.since.getTime()) { excluded.tooOld++; continue; }
    selected.push({ tvmazeEpisodeId: episode.id, season, number, premieredAt: premiere.at, timing: premiere.timing });
  }
  return { episodes: selected, excluded };
}

export type SavedTracking = { seasonsWatched: number; episodesWatched: number };
/**
 * Whether the user's saved tracking already covers an episode. Read-only.
 *
 * Checkpoint semantics (the saved position SxEy):
 * - S2E0: season 1 completed, season 2 not started;
 * - S3E0: seasons 1 and 2 completed;
 * - S2E3: seasons before 2 completed and the first three regular episodes of season 2 watched.
 * Invalid positions (negative, or a season-0 position with episodes) cover nothing, as in the tracking model.
 * Explicit watched-episode records always count.
 */
export function isEpisodeWatched(saved: SavedTracking, watches: { season: number; episode: number }[], season: number, number: number): boolean {
  if (watches.some(w => w.season === season && w.episode === number)) return true;
  const { seasonsWatched: s, episodesWatched: e } = saved;
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < 0) return false;
  return season < s || (season === s && number <= e);
}

/** Show scope "all except Dropped": Watching, Completed, Planned, Paused and shows without a status are eligible. */
export const isShowEligible = (show: { status: string | null }) => show.status !== 'dropped';

export type PushPayload = { title: string; body: string; url: string; tag: string; icon: string; badge: string };
export const NOTIFICATION_ICON = '/icon-192.png?v=2';
/** Opens the show's details in the library. */
export const showUrl = (showId: string) => `/shows?show=${encodeURIComponent(showId)}`;

/**
 * The visible notification. Contains only the title, numbers and a same-origin link: no tokens, user IDs, emails or
 * provider claims (it never says where the episode can be streamed).
 */
export function episodePayload(input: { showName: string; showId: string; tvmazeShowId: number; tvmazeEpisodeId: number; season: number; number: number }): PushPayload {
  const name = input.showName.trim().slice(0, 120) || 'a show in your library';
  return {
    title: `New episode of ${name}`,
    body: `Season ${input.season}, Episode ${input.number} has premiered.`,
    url: showUrl(input.showId),
    // The same tag replaces, rather than stacks, a notification the device already shows for this episode.
    tag: `episode-${input.tvmazeShowId}-${input.tvmazeEpisodeId}`,
    icon: NOTIFICATION_ICON, badge: NOTIFICATION_ICON,
  };
}

export const testPayload = (): PushPayload => ({
  title: 'Cinetra notifications are on',
  body: 'This is a test. New episodes of shows in your library will appear like this.',
  // A fresh tag each time: reusing one would silently replace an earlier test still in Notification Center.
  url: '/', tag: `cinetra-test-${Date.now()}`, icon: NOTIFICATION_ICON, badge: NOTIFICATION_ICON,
});
