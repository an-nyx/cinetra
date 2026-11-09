/**
 * Read-only tracking audit: an independent specification of what every show's tracking state should be,
 * compared against what production returns. Nothing here is show-specific: no titles, IDs or episode counts.
 *
 * This file is deliberately NOT built on src/services/legacy-progress.model.ts, so that it can catch
 * mistakes in that model instead of re-deriving them.
 */

export type Severity = 'error' | 'warning' | 'info';
export type Issue = { code: string; severity: Severity; detail: string; tags?: string[] };

/**
 * defect ................ production is wrong although the available data is sufficient to know the right answer
 * insufficient_metadata . provider data is missing, incomplete or conflicting, so the right answer cannot be determined
 * saved_data_conflict ... the saved position or records do not fit the metadata and need a human decision (never auto-fixed)
 * informational ......... context only; not an inconsistency
 */
export type IssueCategory = 'defect' | 'insufficient_metadata' | 'saved_data_conflict' | 'informational';
export const ISSUE_CATEGORY: Record<string, IssueCategory> = {
  released_count_mismatch: 'defect', effective_watched_mismatch: 'defect', double_counting: 'defect', explicit_count_mismatch: 'defect',
  remaining_count_inconsistent: 'defect', percent_withheld: 'defect', percent_without_reliable_metadata: 'defect', percent_not_100_when_complete: 'defect',
  percent_rounds_to_100: 'defect', percent_incorrect: 'defect', percent_rounds_to_0: 'defect', classification_mismatch: 'defect',
  canceled_series_not_final: 'defect', not_started_reported_in_progress: 'defect', classification_unverified: 'defect', next_episode_withheld: 'defect',
  next_episode_mismatch: 'defect', checkmark_mismatch: 'defect', watch_source_mismatch: 'defect', checkmarks_disagree_with_count: 'defect',
  details_differ_from_list: 'defect', details_unavailable: 'defect', summary_missing: 'defect', summary_error: 'defect',
  card_hides_next_episode: 'defect', card_hides_saved_position: 'defect', review_case_not_surfaced: 'defect', continue_watching_without_next: 'defect', home_upcoming_differs: 'defect',
  unlinked_shows_counted_as_tmdb_failures: 'defect', tvmaze_queried_for_final_series: 'defect',
  upcoming_missing_tmdb_episode: 'defect', tvmaze_replaced_tmdb: 'defect', upcoming_without_tmdb_identity: 'defect', returning_show_missing: 'defect', upcoming_unknown_show: 'defect',
  library_summary_count: 'defect', home_totals_hidden: 'defect', caught_up_continue_watching_split: 'defect', library_tracking_failed: 'defect', upcoming_failed: 'defect',
  no_tmdb_id: 'insufficient_metadata', tmdb_unavailable: 'insufficient_metadata', production_metadata_error: 'insufficient_metadata', episode_guide_unavailable: 'insufficient_metadata',
  no_regular_episodes: 'insufficient_metadata', season_count_mismatch: 'insufficient_metadata', undated_before_released: 'insufficient_metadata',
  upcoming_date_differs_from_tmdb: 'insufficient_metadata', upcoming_for_final_series: 'insufficient_metadata', schedule_conflict: 'insufficient_metadata',
  position_invalid: 'saved_data_conflict', position_season_zero: 'saved_data_conflict', position_earlier_season_missing: 'saved_data_conflict',
  position_season_missing: 'saved_data_conflict', position_exceeds_season: 'saved_data_conflict', position_covers_unaired: 'saved_data_conflict',
  explicit_records_not_in_catalog: 'saved_data_conflict', completed_flags_disagree: 'saved_data_conflict',
  undated_future_episodes: 'informational', future_season_count_mismatch: 'informational', episode_numbering_gap: 'informational',
  position_covers_undated: 'saved_data_conflict', explicit_records_unaired: 'informational', manual_completed_not_verified: 'informational', tvmaze_supplement: 'informational',
};
export const categoryOf = (code: string): IssueCategory | 'uncategorized' => ISSUE_CATEGORY[code] || 'uncategorized';

export type RawShow = {
  id: string; name: string; seasonsWatched: number; episodesWatched: number; completed: boolean; favorite: boolean;
  status?: string | null; tmdbId?: number | null; tvmazeId?: number | null;
};
export type CatalogSeason = { number: number; episodeCount: number };
export type CatalogEpisode = { season: number; number: number; airDate: string | null };
export type Catalog = { seasons: CatalogSeason[]; episodes: CatalogEpisode[] };
export type ExplicitRecord = { season: number; episode: number; watchedAt?: string };
export type TMDBFacts = Catalog & {
  status: string | null; inProduction: boolean | null; nextEpisodeAnnounced: boolean;
  nextEpisode: { season: number; number: number; airDate: string | null } | null;
};
export type GuideEpisode = { number: number; name?: string; airDate: string | null; watched: boolean; watchSource: 'explicit' | 'legacy' | 'both' | null };
export type GuidePage = { seasons: CatalogSeason[]; season: number; episodes: GuideEpisode[]; watched: ExplicitRecord[] };
export type EpisodeRef = { season: number; number: number; name?: string; airDate: string | null };
export type Summary = {
  showId: string; name?: string; status?: string | null; guideAvailable?: boolean; countDataAvailable?: boolean;
  legacyPosition?: { fullSeasons: number; episodesInNextSeason: number; normalizedSeason?: number | null; normalizedEpisode?: number | null; needsReview?: boolean } | null;
  watchedCount?: number; explicitWatchedCount?: number; legacyInferredCount?: number; releasedCount?: number; remainingCount?: number;
  progressPercent?: number | null; broadcastStatus?: string; viewingState?: string; completionEligible?: boolean;
  metadataError?: string | null; statusProgressNote?: string | null;
  nextEpisode?: EpisodeRef | null; upcomingEpisode?: EpisodeRef | null; newEpisodes?: number; error?: string | null;
};
export type UpcomingRelease = { showId: string; season: number | null; number: number | null; name: string; airDate: string; scheduleSource: 'TMDB' | 'TVMaze'; scheduleConflict?: boolean };
export type UpcomingResponse = { releases: UpcomingRelease[]; returningTba: { showId: string; broadcastStatus: string }[]; [diagnostic: string]: unknown };

const pad = (value: number) => String(value).padStart(2, '0');
export const episodeCode = (season: number, episode: number) => `S${pad(season)}E${pad(episode)}`;
const keyOf = (season: number, episode: number) => `${season}:${episode}`;
const codeOfKey = (key: string) => { const [s, e] = key.split(':').map(Number); return episodeCode(s, e); };
const isRegular = (e: CatalogEpisode) => e.season > 0 && e.number > 0;
const isReleased = (e: CatalogEpisode, today: string) => !!e.airDate && e.airDate <= today;
const byOrder = (a: CatalogEpisode, b: CatalogEpisode) => a.season - b.season || a.number - b.number;
const list = (keys: string[], max = 12) => keys.slice(0, max).map(codeOfKey).join(', ') + (keys.length > max ? ` (+${keys.length - max} more)` : '');

export const FINAL_STATUSES = ['Ended', 'Canceled'];
export const CONTINUING_STATUSES = ['Returning Series', 'In Production', 'Planned'];

/** Rebuild the catalog production actually used, from its own episode-guide pages. */
export function catalogFromGuides(pages: GuidePage[]): Catalog {
  return {
    seasons: (pages[0]?.seasons || []).filter(season => season.number > 0),
    episodes: pages.flatMap(page => page.episodes.map(episode => ({ season: page.season, number: episode.number, airDate: episode.airDate || null }))),
  };
}

/** Is the metadata good enough to count released regular episodes? Undated future episodes do not block this. */
export function assessMetadata(catalog: Catalog, today: string) {
  const issues: Issue[] = [];
  const regular = catalog.episodes.filter(isRegular).sort(byOrder);
  const lastReleasedIndex = regular.map(e => isReleased(e, today)).lastIndexOf(true);
  if (!regular.length) issues.push({ code: 'no_regular_episodes', severity: 'warning', detail: 'The provider returned no regular (non-special) episodes.' });
  for (const season of catalog.seasons.filter(s => s.number > 0)) {
    const episodes = regular.filter(e => e.season === season.number);
    if (episodes.length !== season.episodeCount) {
      const affectsReleased = episodes.some(e => isReleased(e, today));
      issues.push({
        code: affectsReleased ? 'season_count_mismatch' : 'future_season_count_mismatch', severity: affectsReleased ? 'warning' : 'info',
        detail: `Season ${season.number} declares ${season.episodeCount} episodes; the provider returned ${episodes.length}.`,
      });
    }
    const numbers = episodes.map(e => e.number);
    const gaps = numbers.filter((n, i) => i > 0 && n !== numbers[i - 1] + 1);
    if (gaps.length || (numbers.length && numbers[0] !== 1)) issues.push({ code: 'episode_numbering_gap', severity: 'info', detail: `Season ${season.number} episode numbers are not contiguous from 1.` });
  }
  const undated = regular.map((e, index) => ({ e, index })).filter(({ e }) => !e.airDate);
  const undatedBeforeReleased = undated.filter(({ index }) => index < lastReleasedIndex).map(({ e }) => keyOf(e.season, e.number));
  const undatedFuture = undated.filter(({ index }) => index > lastReleasedIndex).map(({ e }) => keyOf(e.season, e.number));
  if (undatedBeforeReleased.length) issues.push({ code: 'undated_before_released', severity: 'warning', detail: `Episodes without an air date sit before aired episodes: ${list(undatedBeforeReleased)}.` });
  if (undatedFuture.length) issues.push({ code: 'undated_future_episodes', severity: 'info', detail: `Announced episodes without an air date: ${list(undatedFuture)}.` });
  const blocking = ['no_regular_episodes', 'season_count_mismatch', 'undated_before_released'];
  return { issues, sufficient: !issues.some(issue => blocking.includes(issue.code)), regular, undatedFutureCount: undatedFuture.length };
}

/**
 * The saved legacy position "S{s}E{e}" means: every regular episode of seasons 1..s-1, plus the first e regular
 * episodes of season s (s >= 1). "S{s}E00" means seasons 1..s-1 only. Episodes dated in the future are never covered.
 */
export function assessLegacyPosition(show: Pick<RawShow, 'seasonsWatched' | 'episodesWatched'>, catalog: Catalog, today: string) {
  const issues: Issue[] = [];
  const covered = new Set<string>();
  const { seasonsWatched: s, episodesWatched: e } = show;
  const hasPosition = s !== 0 || e !== 0;
  if (!hasPosition) return { hasPosition, covered, issues, blocking: false };
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 0) {
    issues.push({ code: 'position_invalid', severity: 'error', detail: `Saved position S${s}E${e} is not a valid position.` });
    return { hasPosition, covered, issues, blocking: true };
  }
  if (s === 0) {
    issues.push({ code: 'position_season_zero', severity: 'warning', detail: `Saved position S00E${pad(e)} names no season, so it cannot be mapped to episodes.` });
    return { hasPosition, covered, issues, blocking: true };
  }
  const regular = catalog.episodes.filter(isRegular).sort(byOrder);
  const seasonExists = (n: number) => catalog.seasons.some(season => season.number === n);
  const range: CatalogEpisode[] = [];
  for (let n = 1; n < s; n++) {
    if (!seasonExists(n)) issues.push({ code: 'position_earlier_season_missing', severity: 'warning', detail: `Saved position S${pad(s)}E${pad(e)} implies season ${n} was watched, but the provider has no season ${n}.` });
    range.push(...regular.filter(ep => ep.season === n));
  }
  if (e > 0) {
    const inSeason = regular.filter(ep => ep.season === s);
    if (!seasonExists(s)) issues.push({ code: 'position_season_missing', severity: 'warning', detail: `Saved position S${pad(s)}E${pad(e)} names season ${s}, which the provider does not have.` });
    else if (e > inSeason.length) issues.push({ code: 'position_exceeds_season', severity: 'warning', detail: `Saved position S${pad(s)}E${pad(e)} exceeds the ${inSeason.length} episodes the provider has for season ${s}.` });
    range.push(...inSeason.slice(0, e));
  }
  const unaired = range.filter(ep => !!ep.airDate && ep.airDate > today).map(ep => keyOf(ep.season, ep.number));
  const undated = range.filter(ep => !ep.airDate).map(ep => keyOf(ep.season, ep.number));
  for (const ep of range) if (!(ep.airDate && ep.airDate > today)) covered.add(keyOf(ep.season, ep.number));
  if (unaired.length) issues.push({ code: 'position_covers_unaired', severity: 'warning', detail: `Saved position covers episodes that have not aired: ${list(unaired)}.` });
  if (undated.length) issues.push({ code: 'position_covers_undated', severity: 'warning', detail: `Saved position covers episodes without an air date, which cannot be confirmed as released: ${list(undated)}.` });
  const blocking = issues.some(issue => ['position_earlier_season_missing', 'position_season_missing', 'position_exceeds_season', 'position_covers_unaired', 'position_covers_undated'].includes(issue.code));
  return { hasPosition, covered, issues, blocking };
}

/** Expected effective state for one show, from production's catalog, its saved position and its explicit records. */
export function expectedTracking(show: RawShow, catalog: Catalog, explicit: ExplicitRecord[], today: string) {
  const metadata = assessMetadata(catalog, today);
  const legacy = assessLegacyPosition(show, catalog, today);
  const issues: Issue[] = [...metadata.issues, ...legacy.issues];
  const regularByKey = new Map(metadata.regular.map(e => [keyOf(e.season, e.number), e]));
  const explicitKeys = [...new Set(explicit.map(r => keyOf(r.season, r.episode)))];
  const matched = new Set(explicitKeys.filter(k => regularByKey.has(k)));
  const orphans = explicitKeys.filter(k => !regularByKey.has(k));
  const explicitUnaired = [...matched].filter(k => !isReleased(regularByKey.get(k)!, today));
  if (orphans.length) issues.push({ code: 'explicit_records_not_in_catalog', severity: 'warning', detail: `Individual watch records match no provider episode (kept, but not counted): ${list(orphans)}.` });
  if (explicitUnaired.length) issues.push({ code: 'explicit_records_unaired', severity: 'info', detail: `Individual watch records exist for episodes not yet aired: ${list(explicitUnaired)}.` });

  const checkmarks = new Set([...legacy.covered, ...matched]);
  const released = metadata.regular.filter(e => isReleased(e, today));
  const watchedReleased = released.filter(e => checkmarks.has(keyOf(e.season, e.number)));
  const overlap = [...matched].filter(k => legacy.covered.has(k)).length;
  const explicitCoversAll = metadata.regular.length > 0 && metadata.regular.every(e => matched.has(keyOf(e.season, e.number)));
  const legacyUsable = !legacy.blocking || explicitCoversAll;
  const unavailableReasons: string[] = [];
  if (!metadata.sufficient) unavailableReasons.push(...metadata.issues.filter(i => i.severity !== 'info').map(i => i.detail));
  if (!legacyUsable) unavailableReasons.push(...legacy.issues.filter(i => i.severity !== 'info').map(i => i.detail));
  if (!released.length) unavailableReasons.push('No regular episode has aired yet.');
  const percentAvailable = unavailableReasons.length === 0;
  const exactPercent = percentAvailable ? watchedReleased.length / released.length * 100 : null;
  const next = percentAvailable ? released.find(e => !checkmarks.has(keyOf(e.season, e.number))) || null : null;
  return {
    metadata, legacy, issues, checkmarks, matched, orphans, overlap, released, watchedReleased, explicitCoversAll,
    percentAvailable, exactPercent, unavailableReasons, next, regularCount: metadata.regular.length,
  };
}
export type Expected = ReturnType<typeof expectedTracking>;

/** Expected classification. Manual "Completed" status is deliberately ignored: it never proves episodes were watched. */
export function expectedClassification(expected: Expected, facts: TMDBFacts | null, today: string) {
  if (!expected.legacy.hasPosition && expected.matched.size === 0 && expected.orphans.length === 0) return { state: 'not_started' as const, reason: 'No saved position and no individual watch records.' };
  if (expected.legacy.blocking && !expected.explicitCoversAll) return { state: 'needs_review' as const, reason: expected.legacy.issues.filter(i => i.severity !== 'info').map(i => i.detail).join(' ') };
  if (!facts) return { state: 'unverifiable' as const, reason: 'Independent TMDB facts are unavailable.' };
  if (!expected.percentAvailable) return { state: 'unverifiable' as const, reason: expected.unavailableReasons.join(' ') };
  const status = facts.status || '';
  const watched = expected.watchedReleased.length;
  const allAired = expected.metadata.regular.every(e => isReleased(e, today));
  const final = FINAL_STATUSES.includes(status) && facts.inProduction === false && !facts.nextEpisodeAnnounced && allAired;
  const continuing = CONTINUING_STATUSES.includes(status) || facts.nextEpisodeAnnounced;
  if (watched === expected.released.length) {
    if (final) return { state: 'fully_watched' as const, reason: `Every regular episode is watched and TMDB status "${status}" is final.` };
    if (continuing) return { state: 'caught_up' as const, reason: `Every released episode is watched; TMDB status "${status}" may continue.` };
    return { state: 'unverifiable' as const, reason: `Every released episode is watched, but TMDB status "${status || 'none'}" (in production: ${facts.inProduction}) neither confirms the end nor a continuation.` };
  }
  return { state: 'in_progress' as const, reason: `${expected.released.length - watched} released episode(s) remain.` };
}

// ---------------------------------------------------------------------------------------------------------------
// How each page presents a summary. These mirror frontend/src/lib/tracking.ts, which Shows (components/Show.tsx),
// Home and Continue watching (pages/welcome-page.tsx) share; Details reads GET /show/:id/tracking directly.
// ---------------------------------------------------------------------------------------------------------------
const savedCode = (s: Summary) => (s.legacyPosition ? episodeCode(s.legacyPosition.fullSeasons, s.legacyPosition.episodesInNextSeason) : null);
const nextCode = (s: Summary) => (s.nextEpisode ? episodeCode(s.nextEpisode.season, s.nextEpisode.number) : null);
export function viewingStateLabel(s: Summary) {
  switch (s.viewingState) {
    case 'fully_watched': return 'Fully watched';
    case 'caught_up': return 'Caught up';
    case 'not_started': return 'Not started';
    case 'in_progress': return 'In progress';
    case 'needs_review': return 'Saved position needs review';
    default: return s.guideAvailable ? 'Progress unverified' : 'Episode data unavailable';
  }
}
export function positionDetails(s: Summary) {
  return [savedCode(s) && `Saved ${savedCode(s)}`, nextCode(s) && `Next ${nextCode(s)}`].filter(Boolean).join(' · ');
}
export function showCardLabel(s: Summary) {
  if (s.error) return 'No tracking shown (summary error)';
  return [viewingStateLabel(s), positionDetails(s)].filter(Boolean).join(' · ');
}
export function inContinueWatching(s: Summary) {
  return !s.error && s.viewingState === 'in_progress' && !!s.nextEpisode && !['planned', 'paused', 'dropped'].includes(s.status || '');
}
export function continueWatchingLabel(s: Summary) {
  return [nextCode(s) && `Next ${nextCode(s)}`, savedCode(s) && `Saved position ${savedCode(s)}`].filter(Boolean).join(' · ') || 'Next episode unavailable';
}
export function attentionReason(s: Summary): string | null {
  if (s.error || s.status === 'dropped') return null;
  if (s.viewingState === 'needs_review') return 'Saved position does not fit the episode data';
  if (!s.guideAvailable && (s.legacyPosition || (s.explicitWatchedCount || 0) > 0)) return s.metadataError || 'Episode data unavailable';
  return null;
}
const percentLabel = (p: number | null | undefined) => (p === null || p === undefined ? 'Unavailable' : `${p}%`);

/** Why production withheld a value the audit could compute: used to count root causes across the library. */
function withheldCauses(summary: Summary, expected: Expected) {
  const tags: string[] = [];
  if (expected.metadata.undatedFutureCount) tags.push('undated_future_episodes');
  if (expected.metadata.issues.some(i => i.code === 'future_season_count_mismatch')) tags.push('future_season_count_mismatch');
  if (expected.legacy.issues.some(i => i.code === 'position_covers_undated')) tags.push('position_covers_undated');
  if (summary.legacyPosition?.needsReview) tags.push('production_flags_saved_position');
  if (summary.countDataAvailable === false) tags.push('production_counts_marked_incomplete');
  if (summary.metadataError) tags.push('production_metadata_error');
  return tags.length ? tags : ['cause_not_identified'];
}

const COMPARED_FIELDS = ['watchedCount', 'explicitWatchedCount', 'legacyInferredCount', 'releasedCount', 'remainingCount', 'progressPercent', 'viewingState', 'countDataAvailable', 'metadataError', 'status'] as const;

export type ShowAuditInput = {
  show: RawShow; summary: Summary | null; detail: Summary | null; detailError?: string | null;
  guides: GuidePage[]; guideError?: string | null; facts: TMDBFacts | null; factsError?: string | null;
  upcoming: UpcomingRelease[]; today: string;
};

export function auditShow(input: ShowAuditInput) {
  const { show, summary, detail, guides, facts, today } = input;
  const issues: Issue[] = [];
  const add = (code: string, severity: Severity, detail: string, tags?: string[]) => issues.push({ code, severity, detail, ...(tags?.length ? { tags } : {}) });

  // 7. Metadata availability, with specific reasons.
  if (!show.tmdbId) add('no_tmdb_id', 'warning', 'The show has no TMDB association, so no episode metadata can be loaded.');
  if (input.factsError) add('tmdb_unavailable', 'warning', `Independent TMDB lookup failed: ${input.factsError}.`);
  if (!summary) add('summary_missing', 'error', 'GET /show/tracking returned no entry for this show.');
  else if (summary.error) add('summary_error', 'error', `GET /show/tracking returned an error for this show: ${summary.error}`);
  if (summary?.metadataError) add('production_metadata_error', 'warning', `Production could not load metadata: ${summary.metadataError}`);
  if (show.tmdbId && !guides.length) add('episode_guide_unavailable', 'warning', `GET /show/:id/episodes failed${input.guideError ? `: ${input.guideError}` : ''}.`);

  const catalog = guides.length ? catalogFromGuides(guides) : null;
  const explicit = guides[0]?.watched || [];
  const expected = catalog ? expectedTracking(show, catalog, explicit, today) : null;
  if (expected) issues.push(...expected.issues);
  const classification = expected ? expectedClassification(expected, facts, today) : { state: 'unverifiable' as const, reason: 'Production episode metadata is unavailable.' };

  // Details (GET /show/:id/tracking) must agree with the list endpoint used by Shows, Home and Continue watching.
  if (input.detailError) add('details_unavailable', 'error', `GET /show/:id/tracking failed: ${input.detailError}.`);
  if (summary && detail && !summary.error) {
    const differing = COMPARED_FIELDS.filter(field => JSON.stringify(summary[field] ?? null) !== JSON.stringify(detail[field] ?? null));
    const nextKey = (s: Summary) => (s.nextEpisode ? episodeCode(s.nextEpisode.season, s.nextEpisode.number) : null);
    if (nextKey(summary) !== nextKey(detail)) differing.push('nextEpisode' as never);
    if (differing.length) add('details_differ_from_list', 'error', `Details and the Shows/Home list disagree on: ${differing.join(', ')}.`);
  }

  if (summary && !summary.error && expected) {
    // 2. Effective watched count (no double counting) and 3. released count.
    if (summary.releasedCount !== expected.released.length) add('released_count_mismatch', 'error', `Production reports ${summary.releasedCount} released episodes; its own catalog has ${expected.released.length}.`);
    if (summary.watchedCount !== expected.watchedReleased.length) add('effective_watched_mismatch', 'error', `Production reports ${summary.watchedCount} effectively watched; expected ${expected.watchedReleased.length} (saved position ∪ individual records, released only).`);
    if ((summary.watchedCount ?? 0) > (summary.releasedCount ?? 0)) add('double_counting', 'error', `Watched count ${summary.watchedCount} exceeds released count ${summary.releasedCount}.`);
    if (summary.explicitWatchedCount !== explicit.length) add('explicit_count_mismatch', 'error', `Summary counts ${summary.explicitWatchedCount} individual records; the episode guide lists ${explicit.length}.`);
    if ((summary.remainingCount ?? 0) !== (summary.releasedCount ?? 0) - (summary.watchedCount ?? 0)) add('remaining_count_inconsistent', 'error', `Remaining ${summary.remainingCount} ≠ released ${summary.releasedCount} − watched ${summary.watchedCount}.`);

    // 4. Percentage, including exact 100%.
    const actual = summary.progressPercent ?? null;
    const watched = expected.watchedReleased.length;
    const released = expected.released.length;
    if (actual === null && expected.exactPercent !== null) {
      const causes = [summary.metadataError && `metadata error "${summary.metadataError}"`, summary.legacyPosition?.needsReview && 'saved position flagged for review', summary.countDataAvailable === false && 'production treats the episode counts as incomplete'].filter(Boolean);
      const informational = expected.metadata.issues.filter(i => i.severity === 'info').map(i => i.detail);
      add('percent_withheld', 'warning', `Production shows no percentage, but released-episode metadata is sufficient (${watched}/${released} = ${expected.exactPercent.toFixed(1)}%). Production cause: ${causes.join('; ') || 'not stated'}.${informational.length ? ` Non-blocking metadata notes: ${informational.join(' ')}` : ''}`, withheldCauses(summary, expected));
    } else if (actual !== null && expected.exactPercent === null) {
      add('percent_without_reliable_metadata', 'error', `Production shows ${actual}% although: ${expected.unavailableReasons.join(' ')}`);
    } else if (actual !== null && expected.exactPercent !== null) {
      if (watched === released && actual !== 100) add('percent_not_100_when_complete', 'error', `All ${released} released episodes are watched, but production shows ${actual}%.`);
      else if (watched < released && actual === 100) add('percent_rounds_to_100', 'error', `${released - watched} released episode(s) unwatched, yet production shows 100% (exact ${expected.exactPercent.toFixed(2)}%).`);
      else if (Math.abs(actual - expected.exactPercent) >= 1) add('percent_incorrect', 'error', `Production shows ${actual}%; exact value is ${expected.exactPercent.toFixed(2)}%.`);
      else if (watched > 0 && actual === 0) add('percent_rounds_to_0', 'warning', `${watched} episode(s) watched, but production shows 0%.`);
    }

    // 6. Classification against metadata (manual status ignored).
    const actualState = summary.viewingState || 'unknown';
    const expectedState = classification.state;
    if (expectedState === 'unverifiable') {
      if (!['unknown', 'in_progress'].includes(actualState)) add('classification_unverified', 'error', `Production says "${actualState}", but it cannot be verified: ${classification.reason}`);
    } else if (actualState !== expectedState) {
      const canceled = facts?.status === 'Canceled' && expectedState === 'fully_watched';
      const unstarted = expectedState === 'not_started' && actualState === 'in_progress';
      add(canceled ? 'canceled_series_not_final' : unstarted ? 'not_started_reported_in_progress' : 'classification_mismatch', 'error', `Production says "${actualState}"; expected "${expectedState}" (${classification.reason})${canceled ? ' TMDB "Canceled" is not treated as a final status.' : ''}`, [`${actualState}→${expectedState}`, ...(expected?.percentAvailable && summary.progressPercent === null ? withheldCauses(summary, expected) : [])]);
    }
    if (expected.next && !summary.nextEpisode && actualState !== 'fully_watched') add('next_episode_withheld', 'warning', `Next unwatched released episode is ${episodeCode(expected.next.season, expected.next.number)}, but production offers no next episode.`, withheldCauses(summary, expected));
    if (expected.next && summary.nextEpisode && (summary.nextEpisode.season !== expected.next.season || summary.nextEpisode.number !== expected.next.number)) add('next_episode_mismatch', 'error', `Production next episode ${episodeCode(summary.nextEpisode.season, summary.nextEpisode.number)}; expected ${episodeCode(expected.next.season, expected.next.number)}.`);
  }

  // 5. Checkmarks in Details must match the effective watched state.
  if (expected) {
    const wrong: string[] = []; const wrongSource: string[] = [];
    let releasedChecks = 0;
    for (const page of guides) for (const ep of page.episodes) {
      const key = keyOf(page.season, ep.number);
      const should = expected.checkmarks.has(key);
      if (ep.watched !== should) wrong.push(`${episodeCode(page.season, ep.number)} shows ${ep.watched ? 'watched' : 'unwatched'}`);
      const legacy = expected.legacy.covered.has(key); const explicitHas = expected.matched.has(key);
      const source = legacy && explicitHas ? 'both' : explicitHas ? 'explicit' : legacy ? 'legacy' : null;
      if (ep.watchSource !== source) wrongSource.push(`${episodeCode(page.season, ep.number)} ${ep.watchSource ?? 'none'}→${source ?? 'none'}`);
      if (ep.watched && ep.airDate && ep.airDate <= today && ep.number > 0) releasedChecks++;
    }
    if (wrong.length) add('checkmark_mismatch', 'error', `Checkmarks disagree with the effective state: ${wrong.slice(0, 12).join('; ')}${wrong.length > 12 ? ` (+${wrong.length - 12} more)` : ''}.`);
    if (wrongSource.length) add('watch_source_mismatch', 'warning', `Watch source labels differ: ${wrongSource.slice(0, 8).join('; ')}${wrongSource.length > 8 ? ' …' : ''}.`);
    if (summary && !summary.error && releasedChecks !== summary.watchedCount) add('checkmarks_disagree_with_count', 'error', `${releasedChecks} released episodes are checked in Details, but the summary counts ${summary.watchedCount}.`);
  }

  // Manual status is reported, never trusted as proof.
  const manualCompleted = show.status === 'completed' || (!show.status && show.completed);
  if (manualCompleted && classification.state !== 'fully_watched') add('manual_completed_not_verified', 'info', `Personal status is Completed; metadata ${classification.state === 'unverifiable' ? 'cannot verify it' : `says "${classification.state}"`}. Status left unchanged.`);
  if (show.status && (show.status === 'completed') !== show.completed) add('completed_flags_disagree', 'warning', `status "${show.status}" but completed=${show.completed}; the Shows page Completed filter reads only "completed".`);

  // 8. Cross-page consistency.
  const card = summary ? showCardLabel(summary) : 'No tracking shown';
  const continueWatching = summary ? inContinueWatching(summary) : false;
  if (summary && !summary.error) {
    if (summary.nextEpisode && !card.includes(nextCode(summary)!)) add('card_hides_next_episode', 'warning', `Shows card says "${card}" while Home/Details offer ${nextCode(summary)} as next.`);
    if (summary.legacyPosition && !card.includes(savedCode(summary)!)) add('card_hides_saved_position', 'warning', `Shows card says "${card}" and omits the saved position ${savedCode(summary)}.`);
    if (expected?.legacy.blocking && !expected.explicitCoversAll && !attentionReason(summary)) add('review_case_not_surfaced', 'warning', `The saved position needs review (${expected.legacy.issues.filter(i => i.severity !== 'info').map(i => i.code).join(', ')}) but no page surfaces it for review.`);
    if (continueWatching && !summary.nextEpisode) add('continue_watching_without_next', 'warning', `Listed in Continue watching as "${continueWatchingLabel(summary)}" with no episode to continue.`);
    const homeNext = summary.upcomingEpisode;
    const pageNext = input.upcoming.filter(r => r.airDate > today).sort((a, b) => a.airDate.localeCompare(b.airDate))[0];
    const homeText = homeNext ? `${homeNext.airDate} ${episodeCode(homeNext.season, homeNext.number)}` : 'none';
    const pageText = pageNext ? `${pageNext.airDate} ${pageNext.season && pageNext.number ? episodeCode(pageNext.season, pageNext.number) : `"${pageNext.name}"`} (${pageNext.scheduleSource})` : 'none';
    if ((homeNext?.airDate || null) !== (pageNext?.airDate || null)) add('home_upcoming_differs', 'warning', `Home "Upcoming episodes" shows ${homeText}; the Upcoming page shows ${pageText}.`);
  }

  return {
    showId: show.id, name: show.name, tmdbId: show.tmdbId ?? null,
    legacyPosition: { saved: show.seasonsWatched || show.episodesWatched ? `S${pad(show.seasonsWatched)}E${pad(show.episodesWatched)}` : null, productionNeedsReview: summary?.legacyPosition?.needsReview ?? null },
    effectiveWatched: { production: summary?.watchedCount ?? null, expected: expected?.watchedReleased.length ?? null, explicitRecords: explicit.length || (summary?.explicitWatchedCount ?? 0), legacyInferred: summary?.legacyInferredCount ?? null, coveredByBoth: expected?.overlap ?? null },
    releasedRegular: { production: summary?.releasedCount ?? null, expected: expected?.released.length ?? null, metadataSufficient: expected?.metadata.sufficient ?? false },
    percent: { production: summary?.progressPercent ?? null, expectedExact: expected?.exactPercent === null || expected?.exactPercent === undefined ? null : Number(expected.exactPercent.toFixed(2)), unavailableBecause: expected ? expected.unavailableReasons : ['Production episode metadata is unavailable.'] },
    checkmarksMatch: expected ? !issues.some(i => i.code === 'checkmark_mismatch' || i.code === 'checkmarks_disagree_with_count') : null,
    classification: { production: summary?.viewingState ?? null, expected: classification.state, reason: classification.reason, manualStatus: show.status ?? (show.completed ? 'completed (flag)' : null), tmdbStatus: facts?.status ?? null },
    surfaces: { showsCard: `${card} · ${percentLabel(summary?.progressPercent)}`, continueWatching: continueWatching ? continueWatchingLabel(summary!) : null, details: detail ? `${percentLabel(detail.progressPercent)} · ${detail.countDataAvailable ? `${detail.watchedCount} watched of ${detail.releasedCount}` : 'counts unavailable'} · ${detail.viewingState}` : null },
    issues,
  };
}
export type ShowAudit = ReturnType<typeof auditShow>;

/** Upcoming: TMDB is primary; TVMaze may only add schedule entries TMDB cannot provide. */
export function auditUpcoming(shows: RawShow[], response: UpcomingResponse, factsById: Map<string, TMDBFacts | null>, today: string) {
  const byShow = new Map<string, UpcomingRelease[]>();
  for (const release of response.releases) byShow.set(release.showId, [...(byShow.get(release.showId) || []), release]);
  const tba = new Set(response.returningTba.map(item => item.showId));
  const known = new Set(shows.map(show => show.id));
  const perShow: Record<string, Issue[]> = {};
  const add = (showId: string, code: string, severity: Severity, detail: string) => (perShow[showId] ||= []).push({ code, severity, detail });
  for (const release of response.releases) if (!known.has(release.showId)) add(release.showId, 'upcoming_unknown_show', 'error', 'Upcoming lists a show that is not in the library.');

  const coverage = { tmdbOnly: 0, tvmazeOnly: 0, both: 0, none: 0, noTmdbId: 0 };
  for (const show of shows) {
    const releases = byShow.get(show.id) || [];
    const tmdbReleases = releases.filter(r => r.scheduleSource === 'TMDB');
    const tvmaze = releases.filter(r => r.scheduleSource === 'TVMaze');
    coverage[!show.tmdbId ? 'noTmdbId' : tmdbReleases.length && tvmaze.length ? 'both' : tmdbReleases.length ? 'tmdbOnly' : tvmaze.length ? 'tvmazeOnly' : 'none']++;
    if (!show.tmdbId) { if (releases.length) add(show.id, 'upcoming_without_tmdb_identity', 'error', 'Schedule entries exist for a show without a TMDB association.'); continue; }
    const facts = factsById.get(show.id);
    if (!facts) continue;
    const expected = facts.episodes.filter(e => isRegular(e) && !!e.airDate && e.airDate >= today);
    if (facts.nextEpisode && facts.nextEpisode.airDate && facts.nextEpisode.airDate >= today && !expected.some(e => e.season === facts.nextEpisode!.season && e.number === facts.nextEpisode!.number)) expected.push({ ...facts.nextEpisode });
    const listed = new Map(tmdbReleases.filter(r => r.season && r.number).map(r => [keyOf(r.season!, r.number!), r]));
    const missing = expected.filter(e => !listed.has(keyOf(e.season, e.number)) && !releases.some(r => r.season === e.season && r.number === e.number));
    if (missing.length) add(show.id, 'upcoming_missing_tmdb_episode', 'error', `TMDB dates these episodes, but Upcoming omits them: ${missing.slice(0, 8).map(e => `${episodeCode(e.season, e.number)} ${e.airDate}`).join(', ')}.`);
    for (const e of expected) {
      const r = listed.get(keyOf(e.season, e.number));
      if (r && r.airDate !== e.airDate) add(show.id, 'upcoming_date_differs_from_tmdb', 'warning', `${episodeCode(e.season, e.number)}: Upcoming ${r.airDate}, TMDB now ${e.airDate} (cache or conflict).`);
    }
    const tvmazeOverTmdb = tvmaze.filter(r => r.season && r.number && expected.some(e => e.season === r.season && e.number === r.number));
    if (tvmazeOverTmdb.length) add(show.id, 'tvmaze_replaced_tmdb', 'error', `TVMaze supplied dates TMDB already provides: ${tvmazeOverTmdb.map(r => episodeCode(r.season!, r.number!)).join(', ')}.`);
    if (tvmaze.length) add(show.id, 'tvmaze_supplement', 'info', `TVMaze added ${tvmaze.length} schedule entr${tvmaze.length === 1 ? 'y' : 'ies'} (${tvmaze.filter(r => !r.season).length} unmapped to TMDB numbering); TMDB dated ${expected.length}.`);
    if (FINAL_STATUSES.includes(facts.status || '') && releases.length) add(show.id, 'upcoming_for_final_series', 'warning', `TMDB status is "${facts.status}", yet Upcoming lists ${releases.length} entr${releases.length === 1 ? 'y' : 'ies'}.`);
    if (CONTINUING_STATUSES.includes(facts.status || '') && !releases.length && !tba.has(show.id)) add(show.id, 'returning_show_missing', 'error', `TMDB status "${facts.status}", no dated entry, and not listed as returning without a date.`);
    for (const r of releases.filter(r => r.scheduleConflict)) add(show.id, 'schedule_conflict', 'warning', `${r.season && r.number ? episodeCode(r.season, r.number) : `"${r.name}"`}: TMDB and TVMaze disagree on the date.`);
  }
  const library: Issue[] = [];
  const failureTypes = (response.tmdbFailureTypes || {}) as Record<string, number>;
  const unlinked = shows.filter(show => !show.tmdbId).length;
  if (unlinked && (failureTypes.catalog_404 || 0) > 0) library.push({ code: 'unlinked_shows_counted_as_tmdb_failures', severity: 'warning', detail: `Upcoming reports ${failureTypes.catalog_404} "catalog_404" TMDB failure(s) for ${unlinked} show(s) that have no TMDB association; these are not provider failures.` });
  const definitivelyOver = shows.filter(show => {
    const facts = show.tmdbId ? factsById.get(show.id) : null;
    return !!facts && FINAL_STATUSES.includes(facts.status || '') && facts.inProduction === false && !facts.nextEpisodeAnnounced && !facts.episodes.some(e => isRegular(e) && !!e.airDate && e.airDate >= today);
  }).length;
  const linked = shows.filter(show => show.tmdbId).length;
  const queried = typeof response.tvmazeQueriedShows === 'number' ? response.tvmazeQueriedShows as number
    : ((response.tvmazeVerifiedShows as number) || 0) + ((response.tvmazeAmbiguousShows as number) || 0); // older API: lower bound
  if (queried > linked - definitivelyOver) library.push({ code: 'tvmaze_queried_for_final_series', severity: 'warning', detail: `TVMaze was queried for ${queried} show(s), but only ${linked - definitivelyOver} linked show(s) are not definitively over; at least ${queried - (linked - definitivelyOver)} lookup(s) were for ended/canceled series with nothing scheduled.` });
  return { perShow, coverage, library, releases: response.releases.length, returningWithoutDate: response.returningTba.length };
}

/** Library-level page checks that cannot be attributed to one show. */
export function auditLibrarySurfaces(summaries: Summary[], showCount: number) {
  const issues: Issue[] = [];
  const valid = summaries.filter(s => !s.error);
  if (summaries.length !== showCount) issues.push({ code: 'library_summary_count', severity: 'error', detail: `GET /show returned ${showCount} shows but GET /show/tracking returned ${summaries.length} summaries.` });
  const incomplete = valid.filter(s => !s.countDataAvailable).length;
  if (valid.length !== showCount || incomplete) issues.push({ code: 'home_totals_hidden', severity: 'warning', detail: `Home "Episodes watched" and "Ready to watch" show "—" because ${incomplete + (showCount - valid.length)} show(s) lack complete counts.` });
  const caughtUp = valid.filter(s => s.viewingState === 'caught_up');
  const listed = caughtUp.filter(inContinueWatching).length;
  if (listed && listed < caughtUp.length) issues.push({ code: 'caught_up_continue_watching_split', severity: 'warning', detail: `${listed} caught-up show(s) appear in Continue watching and ${caughtUp.length - listed} do not; the only difference is whether a saved legacy position exists.` });
  return issues;
}

/** Everything that must survive a deployment unchanged. */
export function preservationRecord(show: RawShow, explicit: ExplicitRecord[] | null, explicitCount: number | null) {
  return {
    id: show.id, name: show.name, seasonsWatched: show.seasonsWatched, episodesWatched: show.episodesWatched,
    status: show.status ?? null, completed: show.completed, favorite: show.favorite, tmdbId: show.tmdbId ?? null, tvmazeId: show.tvmazeId ?? null,
    explicitRecords: explicit ? explicit.map(r => `${r.season}:${r.episode}@${r.watchedAt ?? ''}`).sort() : null, explicitCount,
  };
}
export type PreservationRecord = ReturnType<typeof preservationRecord>;

export function comparePreservation(before: PreservationRecord[], after: PreservationRecord[]) {
  const changes: string[] = [];
  const afterById = new Map(after.map(r => [r.id, r]));
  const beforeIds = new Set(before.map(r => r.id));
  for (const b of before) {
    const a = afterById.get(b.id);
    if (!a) { changes.push(`REMOVED show "${b.name}" (${b.id})`); continue; }
    for (const field of ['name', 'seasonsWatched', 'episodesWatched', 'status', 'completed', 'favorite', 'tmdbId', 'tvmazeId', 'explicitCount'] as const) {
      if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) changes.push(`"${b.name}": ${field} ${JSON.stringify(b[field])} → ${JSON.stringify(a[field])}`);
    }
    if (b.explicitRecords && a.explicitRecords) {
      const removed = b.explicitRecords.filter(r => !a.explicitRecords!.includes(r));
      const added = a.explicitRecords.filter(r => !b.explicitRecords!.includes(r));
      if (removed.length) changes.push(`"${b.name}": ${removed.length} individual watch record(s) removed or altered`);
      if (added.length) changes.push(`"${b.name}": ${added.length} individual watch record(s) added`);
    }
  }
  for (const a of after) if (!beforeIds.has(a.id)) changes.push(`ADDED show "${a.name}" (${a.id})`);
  return changes;
}
