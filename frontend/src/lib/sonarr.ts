/**
 * Sonarr panel state (pure; testable in Node). Sonarr is download management only: nothing here reads or changes
 * Cinetra's viewing progress, statuses, favorites or ratings. A downloaded episode is not a watched episode.
 */
export type MonitorOption = "none" | "future" | "missing" | "existing" | "recent" | "pilot" | "firstSeason" | "lastSeason" | "all";
export type MonitorNewItems = "none" | "all";
export type SeriesSummary = { title: string; year: number | null; tvdbId: number; posterUrl: string | null; network: string | null; seasonCount: number; source: "tmdb_external_ids" | "sonarr_tmdb_mapping" };
export type SonarrStatus =
  | { state: "not_configured" }
  | { state: "forbidden" }
  | { state: "no_tmdb_link" }
  | { state: "unmatched"; reason: "no_tvdb_mapping" | "not_found" | "ambiguous" | "conflicting_ids" }
  | { state: "unavailable"; reason: string }
  | { state: "available"; series: SeriesSummary }
  | { state: "exists"; series: SeriesSummary; sonarrUrl: string };
export type RootFolder = { id: number; path: string; accessible: boolean; freeSpace: number | null };
export type QualityProfile = { id: number; name: string };
export type SonarrOptions = { rootFolders: RootFolder[]; qualityProfiles: QualityProfile[]; monitorOptions: MonitorOption[]; defaults: { monitor: MonitorOption; monitorNewItems: MonitorNewItems; searchForMissingEpisodes: boolean } };
/** Adding never monitors or searches anything: the episode request step that follows decides exactly what is monitored. */
export type AddForm = { rootFolderId: number | null; qualityProfileId: number | null; monitorNewItems: MonitorNewItems };

/** What the show dialog renders for a status. `null` while loading. */
export type PanelView =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "add"; series: SeriesSummary }
  | { kind: "exists"; series: SeriesSummary; sonarrUrl: string }
  | { kind: "notice"; message: string; retry: boolean };

export function panelView(status: SonarrStatus | null, loadFailed = false): PanelView {
  if (loadFailed) return { kind: "notice", message: "Sonarr status unavailable right now.", retry: true };
  if (!status) return { kind: "loading" };
  switch (status.state) {
  case "forbidden": return { kind: "hidden" };
  case "not_configured": return { kind: "notice", message: "Sonarr is not configured on this server.", retry: false };
  case "no_tmdb_link": return { kind: "notice", message: "Link this show to TMDB to add it to Sonarr.", retry: false };
  case "unmatched": return { kind: "notice", message: unmatchedMessages[status.reason] || unmatchedMessages.not_found, retry: false };
  case "unavailable": return { kind: "notice", message: status.reason === "unauthorized" ? "Sonarr rejected the server's credentials." : status.reason === "tmdb_unavailable" ? "TMDB is unavailable, so the Sonarr match can't be verified right now." : "Sonarr is unavailable right now.", retry: true };
  case "available": return { kind: "add", series: status.series };
  case "exists": return { kind: "exists", series: status.series, sonarrUrl: status.sonarrUrl };
  default: return { kind: "hidden" };
  }
}

const unmatchedMessages: Record<string, string> = {
  no_tvdb_mapping: "No verified TVDB match for this show, so it can't be added to Sonarr.",
  not_found: "Sonarr couldn't find this show's TVDB series, so it can't be added.",
  ambiguous: "Several Sonarr series match this show. Nothing will be added automatically.",
  conflicting_ids: "TMDB and Sonarr disagree about this show's identity. Nothing will be added automatically.",
};

/** Initial selections. Monitoring always starts at the safe defaults; folders/profiles may reuse the last choice. */
export function initialForm(options: SonarrOptions, remembered?: { rootFolderId?: unknown; qualityProfileId?: unknown } | null): AddForm {
  const usableFolders = options.rootFolders.filter(folder => folder.accessible);
  const rememberedFolder = usableFolders.find(folder => folder.id === remembered?.rootFolderId);
  const rememberedProfile = options.qualityProfiles.find(profile => profile.id === remembered?.qualityProfileId);
  return {
    rootFolderId: rememberedFolder ? rememberedFolder.id : usableFolders.length === 1 ? usableFolders[0].id : null,
    qualityProfileId: rememberedProfile ? rememberedProfile.id : options.qualityProfiles.length === 1 ? options.qualityProfiles[0].id : null,
    monitorNewItems: options.defaults.monitorNewItems,
  };
}

/** Client-side validation mirrors the server's (which re-validates everything). */
export function validateForm(form: AddForm, options: SonarrOptions | null): string | null {
  if (!options) return "Loading Sonarr options…";
  if (!options.rootFolders.some(folder => folder.accessible)) return "Sonarr has no accessible root folder.";
  if (!options.qualityProfiles.length) return "Sonarr has no quality profiles.";
  if (!options.rootFolders.some(folder => folder.accessible && folder.id === form.rootFolderId)) return "Choose a root folder.";
  if (!options.qualityProfiles.some(profile => profile.id === form.qualityProfileId)) return "Choose a quality profile.";
  return null;
}

/** The series is added with nothing monitored and no search; "Monitor new seasons" is the only monitoring choice here. */
export function addRequest(form: AddForm, tvdbId: number) {
  return { tvdbId, rootFolderId: form.rootFolderId as number, qualityProfileId: form.qualityProfileId as number, monitor: "none" as const, monitorNewItems: form.monitorNewItems, searchForMissingEpisodes: false };
}

/** Message for a failed addition, from the server's error code. */
export function addErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
  case "already_exists": return "This series is already in Sonarr.";
  case "in_progress": return "This series is already being added. Please wait.";
  case "identity_changed": return "The matching series changed. Nothing was added; please review it again.";
  case "unmatched": return "Cinetra could not verify the matching Sonarr series, so nothing was added.";
  case "invalid_root_folder": return "The selected root folder is not available in Sonarr.";
  case "invalid_quality_profile": return "The selected quality profile does not exist in Sonarr.";
  case "uncertain": return "Sonarr did not confirm in time. The series may still have been added: check again before retrying.";
  case "timeout": return "Sonarr did not respond in time. Try again in a moment.";
  case "rejected": return "Sonarr rejected the addition. Nothing was added.";
  case "not_configured": return "Sonarr is not configured on this server.";
  case "forbidden": return "Sonarr is not available for this account.";
  case "invalid_request": return "Check the selected options and try again.";
  default: return status === 429 ? "Too many requests. Try again in a moment." : "Could not add the series to Sonarr. Nothing was changed in Cinetra.";
  }
}

/** Sonarr disambiguates remakes in the title itself ("Dark Matter (2024)"): don't show the year twice. */
export function displayYear(series: Pick<SeriesSummary, "title" | "year">): number | null {
  return series.year && !series.title.includes(`(${series.year})`) ? series.year : null;
}

export function formatFreeSpace(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Per-session status cache, so reopening a show does not refetch at once. Additions update it immediately; failures
 * and "unavailable" answers are not cached.
 */
export function createStatusCache(ttlMs = 60_000, now: () => number = Date.now) {
  const entries = new Map<string, { status: SonarrStatus; expires: number }>();
  return {
    get(showId: string) { const hit = entries.get(showId); return hit && hit.expires > now() ? hit.status : null; },
    set(showId: string, status: SonarrStatus) {
      if (status.state === "unavailable") { entries.delete(showId); return; }
      // An existing series stays existing (Cinetra never removes series from Sonarr): keep it longer.
      entries.set(showId, { status, expires: now() + (status.state === "exists" ? ttlMs * 30 : ttlMs) });
    },
    clear() { entries.clear(); },
  };
}

/** One submission at a time: a second click while the first is pending is ignored. */
export function createSubmitGuard() {
  let pending = false;
  return async <T>(run: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> => {
    if (pending) return { ran: false };
    pending = true;
    try { return { ran: true, value: await run() }; }
    finally { pending = false; }
  };
}

/* ---------- Episode requests (series already in Sonarr) ---------- */

export type EpisodeState = "downloaded" | "missing" | "unreleased";
export type RequestMode = "series" | "seasons" | "episodes";
export const REQUEST_MODES: RequestMode[] = ["series", "seasons", "episodes"];
export type EpisodeView = { id: number; seasonNumber: number; episodeNumber: number; title: string | null; airDateUtc: string | null; monitored: boolean; state: EpisodeState };
export type SeasonView = { seasonNumber: number; monitored: boolean; flag: boolean; episodes: EpisodeView[] };
export type EpisodesView = { tvdbId: number; seriesMonitored: boolean; sonarrUrl: string; pending: boolean; seasons: SeasonView[]; checkedAt: string };
export type Selection = { mode: RequestMode; seasons: number[]; episodeIds: number[]; search: boolean };

export const modeLabels: Record<RequestMode, string> = { series: "Entire series", seasons: "Specific seasons", episodes: "Specific episodes" };
export const modeDescriptions: Record<RequestMode, string> = {
  series: "Every episode of every regular season. Specials are not included.",
  seasons: "Every episode of the seasons you pick.",
  episodes: "Only the episodes you pick.",
};

/** Replaces {name} placeholders in an already translated phrase. */
export const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key) => key in values ? String(values[key]) : match);

export function seasonCounts(episodes: EpisodeView[]) {
  return {
    total: episodes.length,
    downloaded: episodes.filter(episode => episode.state === "downloaded").length,
    missing: episodes.filter(episode => episode.state === "missing").length,
    unreleased: episodes.filter(episode => episode.state === "unreleased").length,
    monitored: episodes.filter(episode => episode.monitored).length,
  };
}

/** Seasons shown in the picker: specials (season 0) only when asked for, and only seasons that have episodes. */
export const visibleSeasons = (view: EpisodesView, showSpecials: boolean) => view.seasons.filter(season => season.episodes.length > 0 && (showSpecials || season.seasonNumber > 0));

/**
 * The confirmation summary. Mirrors the server's plan exactly (the server recomputes it from fresh Sonarr data and refuses
 * the request if anything differs), so what is shown is what happens.
 */
export function planSelection(view: EpisodesView, selection: Selection) {
  const all = view.seasons.flatMap(season => season.episodes);
  let selected: EpisodeView[];
  let wholeSeasons: number[] = [];
  if (selection.mode === "series") {
    wholeSeasons = view.seasons.filter(season => season.seasonNumber > 0).map(season => season.seasonNumber);
    selected = all.filter(episode => episode.seasonNumber > 0);
  } else if (selection.mode === "seasons") {
    const wanted = new Set(selection.seasons);
    wholeSeasons = view.seasons.filter(season => wanted.has(season.seasonNumber)).map(season => season.seasonNumber);
    selected = all.filter(episode => wanted.has(episode.seasonNumber));
  } else {
    const wanted = new Set(selection.episodeIds);
    selected = all.filter(episode => wanted.has(episode.id));
  }
  const selectedIds = new Set(selected.map(episode => episode.id));
  const enableSeries = !view.seriesMonitored;
  const counts = seasonCounts(selected);
  const searchable = selected.filter(episode => episode.state === "missing").map(episode => episode.id);
  return {
    selectedIds: [...selectedIds],
    monitorIds: selected.filter(episode => !episode.monitored).map(episode => episode.id),
    seasonNumbers: wholeSeasons.filter(number => view.seasons.some(season => season.seasonNumber === number && season.flag && !season.monitored)),
    enableSeries,
    alsoActivated: enableSeries ? all.filter(episode => episode.monitored && !selectedIds.has(episode.id)).length : 0,
    searchable: searchable.length,
    searchIds: selection.search ? searchable : [],
    counts,
  };
}
export type SelectionPlan = ReturnType<typeof planSelection>;

/** True when confirming would change nothing in Sonarr. */
export const planIsEmpty = (plan: SelectionPlan) => !plan.monitorIds.length && !plan.seasonNumbers.length && !plan.enableSeries && !plan.searchIds.length;

export function selectionProblem(view: EpisodesView | null, selection: Selection, plan: SelectionPlan | null): string | null {
  if (!view) return "Loading episodes…";
  if (view.pending) return "Sonarr is still loading episodes.";
  if (selection.mode === "seasons" && !selection.seasons.length) return "Choose at least one season.";
  if (selection.mode === "episodes" && !selection.episodeIds.length) return "Choose at least one episode.";
  if (!plan || !plan.selectedIds.length) return "The selection has no episodes.";
  if (planIsEmpty(plan)) return "Everything selected is already monitored.";
  return null;
}

export function episodeRequest(view: EpisodesView, selection: Selection, plan: SelectionPlan) {
  return {
    tvdbId: view.tvdbId,
    mode: selection.mode,
    ...(selection.mode === "seasons" ? { seasons: [...selection.seasons].sort((a, b) => a - b) } : {}),
    ...(selection.mode === "episodes" ? { episodeIds: [...selection.episodeIds] } : {}),
    search: selection.search && plan.searchIds.length > 0,
    expected: { monitor: plan.monitorIds.length, seasons: plan.seasonNumbers.length, search: selection.search ? plan.searchIds.length : 0, enableSeries: plan.enableSeries },
  };
}

/** Toggling helpers for the picker (pure). */
export function toggle(list: number[], value: number, on: boolean) {
  const set = new Set(list);
  if (on) set.add(value); else set.delete(value);
  return [...set];
}
export function toggleMany(list: number[], values: number[], on: boolean) {
  const set = new Set(list);
  for (const value of values) { if (on) set.add(value); else set.delete(value); }
  return [...set];
}
/** "all" | "some" | "none" of a season's episodes selected (for the season's tri-state checkbox). */
export function seasonSelection(season: SeasonView, episodeIds: number[]) {
  const set = new Set(episodeIds);
  const count = season.episodes.filter(episode => set.has(episode.id)).length;
  return count === 0 ? "none" : count === season.episodes.length ? "all" : "some";
}
/** Drops specials from a selection when they are hidden again. */
export function withoutSpecials(view: EpisodesView, selection: Selection): Selection {
  const specials = new Set(view.seasons.filter(season => season.seasonNumber === 0).flatMap(season => season.episodes.map(episode => episode.id)));
  return { ...selection, seasons: selection.seasons.filter(number => number !== 0), episodeIds: selection.episodeIds.filter(id => !specials.has(id)) };
}

export const stateLabels: Record<EpisodeState, string> = { downloaded: "On disk", missing: "Missing", unreleased: "Not released" };

export function formatAirDate(value: string | null, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

/** Message for a failed episode request, from the server's error code. */
export function requestErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
  case "selection_changed": return "Sonarr's episode list changed. Nothing was changed; review the selection and confirm again.";
  case "identity_changed": return "The matching series changed. Nothing was changed; please review it again.";
  case "not_in_sonarr": return "This series is no longer in Sonarr.";
  case "episodes_pending": return "Sonarr is still loading episodes. Try again in a moment.";
  case "empty_selection": return "The selection has no episodes.";
  case "in_progress": return "Another Sonarr change for this series is in progress. Please wait.";
  case "not_applied": return "Sonarr refused the change. Nothing was changed.";
  case "uncertain": return "Sonarr did not confirm in time. Some episodes may be monitored: check again before retrying. No search was started.";
  case "partial": return "The episodes are marked monitored, but Sonarr did not confirm series or season monitoring. No search was started. Try again.";
  case "unverified": return "Sonarr did not confirm the new monitoring, so no search was started. Check again in a moment.";
  case "search_failed": return "Monitoring is saved, but the search could not be started. Sonarr will still pick up monitored episodes from its RSS feeds.";
  case "unmatched": return "Cinetra could not verify the matching Sonarr series, so nothing was changed.";
  case "timeout": return "Sonarr did not respond in time. Try again in a moment.";
  case "unavailable": return "Sonarr is unavailable right now. Try again in a moment.";
  case "not_configured": return "Sonarr is not configured on this server.";
  case "forbidden": return "Sonarr is not available for this account.";
  case "invalid_request": return "Check the selection and try again.";
  default: return status === 429 ? "Too many requests. Try again in a moment." : "Could not update Sonarr. Nothing was changed in Cinetra.";
  }
}

/** Errors after which Sonarr's current state must be re-read before trying again. */
export const reloadAfter = (code: string | undefined) => ["selection_changed", "episodes_pending", "uncertain", "partial", "unverified", "search_failed", "identity_changed", "not_in_sonarr"].includes(code || "");
