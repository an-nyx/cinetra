/**
 * Manual premiere-time overrides (pure: no network, no database). See docs/release-overrides.md.
 *
 * An override states WHEN a canonical TMDB episode is released; it never changes which episode it is (TMDB season
 * and number stay the identity) and it never touches viewing records or statuses. Overrides come only from the
 * version-controlled file backend/config/release-overrides.json. Nothing here ever invents a release time from a
 * streaming platform's habits: every entry carries its own source, time zone and wall-clock time.
 *
 * Two forms:
 * - episode: one episode, an explicit local date and time, and the TMDB air date it was checked against
 *   (`tmdbAirDate`); if TMDB later lists another date, the entry is stale and ignored.
 * - season: a documented season-wide schedule ("each episode at 21:00 America/New_York on its TMDB date") limited to
 *   an episode range and to the TMDB date range the source covers.
 *
 * The TMDB-date guard. A TMDB air date D is a calendar date in some (unstated) time zone. Real zones span UTC-12 to
 * UTC+14, so D is the local date somewhere on Earth exactly during [D-1 10:00Z, D+1 12:00Z). A release instant is
 * accepted only when its local date in the entry's own time zone is D ("tmdb_date"), or D-1 provided the instant is
 * already D in UTC ("day_before_tmdb_date": a release announced as e.g. 18:00 Los Angeles time on the evening before,
 * which is D 02:00Z). Every accepted instant therefore lies inside D's window: never later than the conservative
 * fallback (D+1 12:00Z) and never before D has begun anywhere. A release on the preceding local day whose instant is
 * still before D in UTC is rejected; it must be written in a time zone in which its local date is D.
 */

export type OverrideSource = { url: string; publisher: string; scope: 'episode' | 'season'; description?: string };
type Common = { id: string; tmdbId: number; show: string; season: number; timeZone: string; source: OverrideSource; verifiedAt: string };
export type EpisodeOverride = Common & { kind: 'episode'; episode: number; releaseLocal: string; tmdbAirDate: string };
export type SeasonOverride = Common & {
  kind: 'season'; episodes: { from: number; to: number }; localTime: string;
  localDay: 'tmdb_date' | 'day_before_tmdb_date'; tmdbAirDates: { from: string; to: string };
};
export type ReleaseOverride = EpisodeOverride | SeasonOverride;
export type RejectedOverride = { index: number; id: string | null; reasons: string[] };

export type OverrideStatus =
  | 'applied' | 'redundant' | 'conflict_tvmaze_exact' | 'conflict_tvmaze_date' | 'stale_tmdb_date'
  | 'outside_tmdb_date' | 'nonexistent_local_time' | 'ambiguous_local_time' | 'no_tmdb_date' | 'no_matching_episode';
export type OverrideOutcome = { id: string; season: number; episode: number; status: OverrideStatus; releaseAt: string | null; detail: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})T(([01]\d|2[0-3]):[0-5]\d)$/;
const ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
// IANA names only ("America/New_York", "Europe/Paris", "UTC"); abbreviations such as EST/PST/ET are refused.
const ZONE = /^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;
const DAY_MS = 86_400_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export function isIanaTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !ZONE.test(zone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock date and time of an instant in a zone. */
function wallClock(instant: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
const offsetAt = (instant: number, timeZone: string) => {
  const { date, time } = wallClock(instant, timeZone);
  return Date.parse(`${date}T${time}:00Z`) - Math.floor(instant / 60_000) * 60_000;
};

/**
 * Every UTC instant at which the wall clock in `timeZone` reads `date` `time`. One instant normally; none inside a
 * daylight-saving gap (the time never happens); two inside a fall-back overlap (it happens twice).
 */
export function localInstants(date: string, time: string, timeZone: string): number[] {
  const wall = Date.parse(`${date}T${time}:00Z`);
  const offsets = new Set([-36, -12, 0, 12, 36].map(h => offsetAt(wall + h * 3_600_000, timeZone)));
  const found = new Set<number>();
  for (const offset of offsets) {
    const candidate = wall - offset;
    const clock = wallClock(candidate, timeZone);
    if (clock.date === date && clock.time === time) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/** Resolve an entry's local time for one TMDB air date, applying the TMDB-date guard. */
function instantFor(override: ReleaseOverride, tmdbDate: string): { at: string } | { status: OverrideStatus; detail: string } {
  const localDate = override.kind === 'episode' ? override.releaseLocal.slice(0, 10) : override.localDay === 'tmdb_date' ? tmdbDate : addDays(tmdbDate, -1);
  const time = override.kind === 'episode' ? override.releaseLocal.slice(11) : override.localTime;
  if (localDate !== tmdbDate && localDate !== addDays(tmdbDate, -1))
    return { status: 'outside_tmdb_date', detail: `Local date ${localDate} is neither TMDB's ${tmdbDate} nor the day before` };
  const instants = localInstants(localDate, time, override.timeZone);
  if (!instants.length) return { status: 'nonexistent_local_time', detail: `${localDate} ${time} does not exist in ${override.timeZone} (daylight-saving gap)` };
  if (instants.length > 1) return { status: 'ambiguous_local_time', detail: `${localDate} ${time} happens twice in ${override.timeZone} (daylight-saving overlap)` };
  const at = instants[0];
  if (localDate !== tmdbDate && at < Date.parse(`${tmdbDate}T00:00:00Z`))
    return { status: 'outside_tmdb_date', detail: `The day-before release ${new Date(at).toISOString()} is still before TMDB's ${tmdbDate} in UTC; state it in a time zone whose local date is ${tmdbDate}` };
  return { at: new Date(at).toISOString() };
}

const COMMON_KEYS = ['id', 'tmdbId', 'show', 'season', 'timeZone', 'source', 'verifiedAt'];
const EPISODE_KEYS = new Set([...COMMON_KEYS, 'episode', 'releaseLocal', 'tmdbAirDate']);
const SEASON_KEYS = new Set([...COMMON_KEYS, 'episodes', 'localTime', 'localDay', 'tmdbAirDates']);
const SOURCE_KEYS = new Set(['url', 'publisher', 'scope', 'description']);

function validateEntry(entry: unknown, today: string): { override: ReleaseOverride } | { reasons: string[] } {
  if (!isRecord(entry)) return { reasons: ['Entry must be an object'] };
  const reasons: string[] = [];
  const isEpisode = 'episode' in entry; const isSeason = 'episodes' in entry;
  if (isEpisode === isSeason) return { reasons: ['Entry must have exactly one of "episode" (one episode) or "episodes" (a season range)'] };
  const allowed = isEpisode ? EPISODE_KEYS : SEASON_KEYS;
  for (const key of Object.keys(entry)) if (!allowed.has(key)) reasons.push(`Unknown field "${key}"`);
  for (const key of allowed) if (!(key in entry) && key !== 'description') reasons.push(`Missing field "${key}"`);
  if (!(typeof entry.id === 'string' && ID.test(entry.id))) reasons.push('id must be 3-64 lowercase letters, digits or dashes');
  if (!positiveInt(entry.tmdbId)) reasons.push('tmdbId must be a positive integer');
  if (!(typeof entry.show === 'string' && entry.show.trim())) reasons.push('show must name the series (for reviewers)');
  if (!positiveInt(entry.season)) reasons.push('season must be a regular season number (1 or more)');
  if (!isIanaTimeZone(entry.timeZone)) reasons.push(`timeZone must be an IANA zone such as "America/New_York" (got ${JSON.stringify(entry.timeZone)})`);
  if (!validDate(entry.verifiedAt) || entry.verifiedAt > today) reasons.push('verifiedAt must be a real date, not in the future');
  const source = entry.source;
  if (!isRecord(source)) reasons.push('source must be an object');
  else {
    for (const key of Object.keys(source)) if (!SOURCE_KEYS.has(key)) reasons.push(`Unknown source field "${key}"`);
    let url: URL | null = null;
    try { url = typeof source.url === 'string' ? new URL(source.url) : null; } catch { url = null; }
    if (!url || url.protocol !== 'https:') reasons.push('source.url must be an https link to the announcement');
    if (!(typeof source.publisher === 'string' && source.publisher.trim())) reasons.push('source.publisher must name who published it');
    if (source.scope !== 'episode' && source.scope !== 'season') reasons.push('source.scope must be "episode" or "season"');
    if (isSeason && source.scope !== 'season') reasons.push('A season entry needs a season-wide source (source.scope "season")');
    if (source.description !== undefined && typeof source.description !== 'string') reasons.push('source.description must be text');
  }
  if (isEpisode) {
    if (!positiveInt(entry.episode)) reasons.push('episode must be a regular episode number (1 or more)');
    const local = typeof entry.releaseLocal === 'string' ? LOCAL.exec(entry.releaseLocal) : null;
    if (!local || !validDate(local[1])) reasons.push('releaseLocal must be a local date and time "YYYY-MM-DDTHH:MM" (no offset; the zone is timeZone)');
    if (!validDate(entry.tmdbAirDate)) reasons.push('tmdbAirDate must be the TMDB air date "YYYY-MM-DD" this entry was checked against');
  } else {
    const range = entry.episodes;
    if (!isRecord(range) || !positiveInt(range.from) || !positiveInt(range.to) || range.from > range.to || Object.keys(range).some(k => k !== 'from' && k !== 'to'))
      reasons.push('episodes must be { "from": n, "to": m } with 1 <= n <= m');
    if (!(typeof entry.localTime === 'string' && TIME.test(entry.localTime))) reasons.push('localTime must be "HH:MM" (24-hour)');
    if (entry.localDay !== 'tmdb_date' && entry.localDay !== 'day_before_tmdb_date') reasons.push('localDay must be "tmdb_date" or "day_before_tmdb_date"');
    const dates = entry.tmdbAirDates;
    if (!isRecord(dates) || !validDate(dates.from) || !validDate(dates.to) || dates.from > dates.to || Object.keys(dates).some(k => k !== 'from' && k !== 'to'))
      reasons.push('tmdbAirDates must be { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }, the TMDB dates the source covers');
    else if (Date.parse(`${dates.to}T00:00:00Z`) - Date.parse(`${dates.from}T00:00:00Z`) > 366 * DAY_MS) reasons.push('tmdbAirDates may cover at most one year');
  }
  if (reasons.length) return { reasons };
  if (isEpisode) {
    const override = { ...(entry as unknown as Omit<EpisodeOverride, 'kind'>), kind: 'episode' as const };
    // The entry must be self-consistent for the TMDB date it was checked against.
    const check = instantFor(override, override.tmdbAirDate);
    if ('status' in check) return { reasons: [check.detail] };
    return { override };
  }
  return { override: { ...(entry as unknown as Omit<SeasonOverride, 'kind'>), kind: 'season' } };
}

const overlaps = (a: { from: number | string; to: number | string }, b: { from: number | string; to: number | string }) => a.from <= b.to && b.from <= a.to;

/**
 * Validate the whole file. Invalid entries are rejected with reasons and never partially applied. Conflicts reject
 * every entry involved: duplicate ids, two entries for the same episode, and season entries for the same season whose
 * episode and date ranges overlap. (An episode entry inside a season entry is allowed: the episode entry wins.)
 */
export function parseOverrideConfig(raw: unknown, today: string): { overrides: ReleaseOverride[]; rejected: RejectedOverride[]; error: string | null } {
  if (!isRecord(raw)) return { overrides: [], rejected: [], error: 'The file must contain a JSON object' };
  if (raw.version !== 1) return { overrides: [], rejected: [], error: 'Unsupported "version" (expected 1)' };
  if (!Array.isArray(raw.overrides)) return { overrides: [], rejected: [], error: '"overrides" must be an array' };
  const extra = Object.keys(raw).filter(k => k !== 'version' && k !== 'overrides' && k !== '$comment');
  if (extra.length) return { overrides: [], rejected: [], error: `Unknown top-level field(s): ${extra.join(', ')}` };
  const rejected: RejectedOverride[] = [];
  const valid: { index: number; override: ReleaseOverride }[] = [];
  raw.overrides.forEach((entry, index) => {
    const result = validateEntry(entry, today);
    if ('reasons' in result) rejected.push({ index, id: isRecord(entry) && typeof entry.id === 'string' ? entry.id : null, reasons: result.reasons });
    else valid.push({ index, override: result.override });
  });
  const conflicts = new Map<number, string[]>();
  const flag = (index: number, reason: string) => conflicts.set(index, [...(conflicts.get(index) || []), reason]);
  for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
    const a = valid[i].override; const b = valid[j].override;
    if (a.id === b.id) { flag(valid[i].index, `Duplicate id "${a.id}"`); flag(valid[j].index, `Duplicate id "${b.id}"`); continue; }
    if (a.tmdbId !== b.tmdbId || a.season !== b.season) continue;
    if (a.kind === 'episode' && b.kind === 'episode' && a.episode === b.episode) {
      flag(valid[i].index, `Conflicts with "${b.id}" (same episode)`); flag(valid[j].index, `Conflicts with "${a.id}" (same episode)`);
    }
    if (a.kind === 'season' && b.kind === 'season' && overlaps(a.episodes, b.episodes) && overlaps(a.tmdbAirDates, b.tmdbAirDates)) {
      flag(valid[i].index, `Conflicts with "${b.id}" (overlapping season ranges)`); flag(valid[j].index, `Conflicts with "${a.id}" (overlapping season ranges)`);
    }
  }
  for (const [index, reasons] of conflicts) rejected.push({ index, id: valid.find(v => v.index === index)!.override.id, reasons });
  rejected.sort((a, b) => a.index - b.index);
  return { overrides: valid.filter(v => !conflicts.has(v.index)).map(v => v.override), rejected, error: null };
}

/**
 * The override that governs one catalog episode, and the instant it states. Episode entries win over season entries.
 * Returns null when no entry is meant for this episode.
 */
export function resolveOverride(overrides: readonly ReleaseOverride[], episode: { season: number; number: number; airDate: string | null }):
  { override: ReleaseOverride; result: { at: string } | { status: OverrideStatus; detail: string } } | null {
  const forEpisode = overrides.find(o => o.kind === 'episode' && o.season === episode.season && o.episode === episode.number);
  const forSeason = overrides.find(o => o.kind === 'season' && o.season === episode.season && episode.number >= o.episodes.from && episode.number <= o.episodes.to
    && !!episode.airDate && episode.airDate >= o.tmdbAirDates.from && episode.airDate <= o.tmdbAirDates.to);
  const override = forEpisode ?? forSeason;
  if (!override) return null;
  if (!episode.airDate || !DATE.test(episode.airDate)) return { override, result: { status: 'no_tmdb_date', detail: 'TMDB lists no air date for this episode' } };
  if (override.kind === 'episode' && override.tmdbAirDate !== episode.airDate)
    return { override, result: { status: 'stale_tmdb_date', detail: `Checked against TMDB date ${override.tmdbAirDate}, but TMDB now lists ${episode.airDate}` } };
  return { override, result: instantFor(override, episode.airDate) };
}
