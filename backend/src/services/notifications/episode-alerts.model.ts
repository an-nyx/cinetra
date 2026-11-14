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

export type PushPayload = { title: string; body: string; url: string; tag: string; icon: string; badge: string; image?: string };
export const NOTIFICATION_ICON = '/icon-192.png?v=2';
/** Opens the show's details in the library. */
export const showUrl = (showId: string) => `/shows?show=${encodeURIComponent(showId)}`;

/**
 * What kind of release an episode is, used only to choose wording.
 * - Premieres come from TVMaze's own numbering (episode 1 of a season), which the notifier already trusts.
 * - Finales are only claimed when TMDB's catalog labels the same season/episode a finale *and* its air date agrees
 *   with TVMaze's (see verifiedFinaleKind); anything uncertain is a regular episode.
 */
export type EpisodeKind = 'series_premiere' | 'season_premiere' | 'season_finale' | 'midseason_finale' | 'regular';

export function premiereKind(season: number, number: number): EpisodeKind {
  if (number !== 1) return 'regular';
  return season === 1 ? 'series_premiere' : 'season_premiere';
}

/**
 * A finale label from TMDB, trusted only when TMDB's episode at the same season/number aired within a few days of
 * the TVMaze premiere instant (guards against the two providers numbering seasons differently). Premieres win.
 */
export function verifiedFinaleKind(tmdb: { episodeType: string | null | undefined; airDate: string | null | undefined } | null, premieredAt: Date): EpisodeKind | null {
  if (!tmdb?.episodeType || !tmdb.airDate || !/^\d{4}-\d{2}-\d{2}$/.test(tmdb.airDate)) return null;
  const aired = Date.parse(`${tmdb.airDate}T00:00:00Z`);
  // TVMaze's conservative instant is at most ~1.5 days after the listed date; TMDB dates can lead by a day (time zones).
  const lead = premieredAt.getTime() - aired;
  if (lead < -2 * 86_400_000 || lead > 4 * 86_400_000) return null;
  if (tmdb.episodeType === 'finale') return 'season_finale';
  if (tmdb.episodeType === 'mid_season') return 'midseason_finale';
  return null;
}

/** S02E09 (at least two digits each; long-running numbering like S2026E225 stays as is). */
export const episodeCode = (season: number, number: number) => `S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}`;

/** Titles longer than this are shown on their own; the event moves to the body (Lock Screen titles are one line). */
export const COMPACT_TITLE_AFTER = 44;
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);
/** "The X season finale" without doubling an article the show title already starts with ("The Bear season finale"). */
const theShow = (name: string) => (/^the\s/i.test(name) ? name : `The ${name}`);
const label: Record<EpisodeKind, string> = {
  series_premiere: 'Series premiere', season_premiere: 'Season premiere', season_finale: 'Season finale', midseason_finale: 'Midseason finale', regular: 'New episode',
};

/**
 * Cinematic wording for a release. Deterministic (the same episode always reads the same way), short enough for a
 * Lock Screen, no emojis, no plot details and no claims about where to watch. The show title is never altered,
 * only trimmed when it exceeds 120 characters.
 */
export function episodeCopy(input: { showName: string; season: number; number: number; kind: EpisodeKind; tvmazeEpisodeId: number }): { title: string; body: string } {
  const name = input.showName.trim().slice(0, 120) || 'A show in your library';
  const code = episodeCode(input.season, input.number);
  const templates: Record<EpisodeKind, { title: string; body: string }> = {
    series_premiere: { title: sentence(`${name} has arrived`), body: `The story begins. ${code} has premiered.` },
    season_premiere: { title: sentence(`${name} is back`), body: `A new season begins. ${code} has premiered.` },
    season_finale: { title: `${theShow(name)} season finale is here.`, body: `${code} has premiered. Time for the final chapter.` },
    midseason_finale: { title: `${theShow(name)} midseason finale is here.`, body: `${code} has premiered before the midseason break.` },
    // Two alternating phrasings so a weekly show does not read identically every week.
    regular: input.tvmazeEpisodeId % 2 === 0
      ? { title: sentence(`A new chapter of ${name}`), body: `${code} just premiered. Your next episode awaits.` }
      : { title: sentence(`${name} continues`), body: `${code} just premiered. Your next episode awaits.` },
  };
  const chosen = templates[input.kind];
  if (chosen.title.length <= COMPACT_TITLE_AFTER) return chosen;
  const compactBody: Record<EpisodeKind, string> = {
    series_premiere: `Series premiere · ${code} has premiered. The story begins.`,
    season_premiere: `Season premiere · ${code} has premiered. A new season begins.`,
    season_finale: `Season finale · ${code} has premiered. Time for the final chapter.`,
    midseason_finale: `Midseason finale · ${code} has premiered before the break.`,
    regular: `${label.regular} · ${code} just premiered. Your next episode awaits.`,
  };
  return { title: name, body: compactBody[input.kind] };
}

// Public artwork hosts Cinetra already stores posters from. Anything else is dropped rather than displayed.
const ARTWORK = [
  { host: 'image.tmdb.org', path: /^\/t\/p\/[a-z0-9]+\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/ },
  { host: 'static.tvmaze.com', path: /^\/uploads\/images\/[a-z_]+\/\d+\/\d+\.(jpg|jpeg|png|webp)$/ },
];
/**
 * The saved show's own poster as a notification image, or undefined. Only clean HTTPS URLs on the known artwork
 * hosts, with no query, fragment or credentials (nothing private can ride along). Large originals are swapped for
 * the provider's mid-size rendition, which loads quickly on a phone.
 */
export function notificationImage(posterURL: string | null | undefined): string | undefined {
  if (!posterURL || posterURL.length > 500) return undefined;
  let url: URL;
  try { url = new URL(posterURL); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return undefined;
  const rule = ARTWORK.find(a => a.host === url.hostname);
  if (!rule || !rule.path.test(url.pathname)) return undefined;
  if (url.hostname === 'image.tmdb.org') url.pathname = url.pathname.replace(/^\/t\/p\/[a-z0-9]+\//, '/t/p/w780/');
  else url.pathname = url.pathname.replace(/^\/uploads\/images\/original_untouched\//, '/uploads/images/medium_portrait/');
  return url.toString();
}

/**
 * The visible notification. Contains only wording, numbers, a same-origin link and (when the saved show has one) its
 * public poster URL: no tokens, user IDs, emails or provider claims (it never says where the episode can be streamed).
 */
export function episodePayload(input: { showName: string; showId: string; tvmazeShowId: number; tvmazeEpisodeId: number; season: number; number: number; kind?: EpisodeKind; posterURL?: string | null }): PushPayload {
  const kind = input.kind ?? premiereKind(input.season, input.number);
  const { title, body } = episodeCopy({ showName: input.showName, season: input.season, number: input.number, kind, tvmazeEpisodeId: input.tvmazeEpisodeId });
  const image = notificationImage(input.posterURL);
  return {
    title, body,
    url: showUrl(input.showId),
    // The same tag replaces, rather than stacks, a notification the device already shows for this episode.
    tag: `episode-${input.tvmazeShowId}-${input.tvmazeEpisodeId}`,
    icon: NOTIFICATION_ICON, badge: NOTIFICATION_ICON,
    ...(image ? { image } : {}),
  };
}

/**
 * A clearly labelled preview of the episode-alert style for one of the user's own shows, sent only from the
 * explicit preview button to the requesting device. Never written to the delivery ledger.
 */
export function previewPayload(input: { showName: string; showId: string; season: number; number: number; posterURL?: string | null }): PushPayload {
  const kind = premiereKind(input.season, input.number);
  const copy = episodeCopy({ showName: input.showName, season: input.season, number: input.number, kind, tvmazeEpisodeId: 0 });
  const image = notificationImage(input.posterURL);
  return {
    title: `Preview · ${copy.title}`,
    body: `${copy.body} This is how new episodes will look.`,
    url: showUrl(input.showId),
    tag: `cinetra-preview-${Date.now()}`,
    icon: NOTIFICATION_ICON, badge: NOTIFICATION_ICON,
    ...(image ? { image } : {}),
  };
}

export const testPayload = (): PushPayload => ({
  title: 'Cinetra notifications are on',
  body: 'This is a test. New episodes of shows in your library will appear like this.',
  // A fresh tag each time: reusing one would silently replace an earlier test still in Notification Center.
  url: '/', tag: `cinetra-test-${Date.now()}`, icon: NOTIFICATION_ICON, badge: NOTIFICATION_ICON,
});
