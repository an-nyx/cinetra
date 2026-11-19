/**
 * Radarr panel state (pure; testable in Node). Radarr is download management only: nothing here reads or changes
 * Cinetra's movie statuses, watch history, ratings, notes or favorites. A downloaded movie is not a watched movie.
 *
 * Five separate things, never conflated: adding a movie to Radarr, monitoring it, searching for it, Radarr downloading
 * it, and watching it in Cinetra (which only you record, in the tracking section).
 */
export type MovieSummary = { title: string; year: number | null; tmdbId: number; posterUrl: string | null; studio: string | null; runtime: number | null };
export type FileState = "on_disk" | "missing" | "unreleased" | "unknown";
export type QueueState = "downloading" | "queued" | "paused" | "importing" | "issue";
export type QueueView = { state: QueueState; progress: number | null } | null;
/** canSearch: Radarr's state allows a search now (released, missing, not queued, not searched minutes ago). */
export type RadarrState = { monitored: boolean; fileState: FileState; queue: QueueView; canSearch: boolean };
export type RadarrStatus =
  | { state: "not_configured" }
  | { state: "forbidden" }
  | { state: "no_tmdb_link" }
  | { state: "unmatched"; reason: "not_found" | "conflicting_ids" }
  | { state: "unavailable"; reason: string }
  | { state: "available"; movie: MovieSummary }
  | { state: "exists"; movie: MovieSummary; radarrUrl: string; radarr: RadarrState };
export type MinimumAvailability = "announced" | "inCinemas" | "released";
export type RootFolder = { id: number; path: string; accessible: boolean; freeSpace: number | null };
export type QualityProfile = { id: number; name: string };
export type RadarrOptions = { rootFolders: RootFolder[]; qualityProfiles: QualityProfile[]; minimumAvailability: MinimumAvailability[]; defaults: { monitored: boolean; searchForMovie: boolean; minimumAvailability: MinimumAvailability } };
export type AddForm = { rootFolderId: number | null; qualityProfileId: number | null; minimumAvailability: MinimumAvailability; monitored: boolean; searchForMovie: boolean };
export type SearchBlock = null | "on_disk" | "unreleased" | "unknown" | "queued" | "recently_searched";
export type RequestView = {
  tmdbId: number; movie: MovieSummary; radarrUrl: string; monitored: boolean; fileState: FileState; queue: QueueView;
  canMonitor: boolean; canSearch: boolean; searchBlock: SearchBlock; checkedAt: string;
};

/** What the movie dialog renders for a status. */
export type PanelView =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "add"; movie: MovieSummary }
  | { kind: "exists"; movie: MovieSummary; radarrUrl: string; radarr: RadarrState; requestable: boolean }
  | { kind: "notice"; message: string; retry: boolean };

/** "Request movie" is offered only when it can change something: never for a movie on disk. */
export const isRequestable = (radarr: RadarrState) =>
  radarr.fileState !== "on_disk" && radarr.fileState !== "unknown" && (!radarr.monitored || radarr.canSearch);

export function panelView(status: RadarrStatus | null, loadFailed = false): PanelView {
  if (loadFailed) return { kind: "notice", message: "Radarr status unavailable right now.", retry: true };
  if (!status) return { kind: "loading" };
  switch (status.state) {
  case "forbidden": return { kind: "hidden" };
  case "not_configured": return { kind: "notice", message: "Radarr is not configured on this server.", retry: false };
  case "no_tmdb_link": return { kind: "notice", message: "This movie has no TMDB link, so it can't be added to Radarr.", retry: false };
  case "unmatched": return { kind: "notice", message: status.reason === "conflicting_ids" ? "Radarr returned a different movie for this TMDB ID. Nothing will be added automatically." : "Radarr couldn't find this TMDB movie, so it can't be added.", retry: false };
  case "unavailable": return { kind: "notice", message: status.reason === "unauthorized" ? "Radarr rejected the server's credentials." : "Radarr is unavailable right now.", retry: true };
  case "available": return { kind: "add", movie: status.movie };
  case "exists": return { kind: "exists", movie: status.movie, radarrUrl: status.radarrUrl, radarr: status.radarr, requestable: isRequestable(status.radarr) };
  default: return { kind: "hidden" };
  }
}

export type Badge = { key: string; label: string; tone: "primary" | "warning" | "muted"; progress?: number | null };
export const fileLabels: Record<Exclude<FileState, "unknown">, string> = { on_disk: "On Disk", missing: "Missing", unreleased: "Not Released" };
export const queueLabels: Record<QueueState, string> = { downloading: "Downloading", queued: "Queued for download", paused: "Download paused", importing: "Importing", issue: "Download issue" };

/** Status badges, only for what Radarr confirmed. Unknown file states show nothing rather than a guess. */
export function badges(radarr: RadarrState): Badge[] {
  const list: Badge[] = [{ key: "monitored", label: radarr.monitored ? "Monitored" : "Not Monitored", tone: radarr.monitored ? "primary" : "muted" }];
  if (radarr.fileState !== "unknown") list.push({ key: "file", label: fileLabels[radarr.fileState], tone: radarr.fileState === "on_disk" ? "primary" : radarr.fileState === "missing" ? "warning" : "muted" });
  if (radarr.queue && radarr.fileState !== "on_disk") list.push({ key: "queue", label: queueLabels[radarr.queue.state], tone: radarr.queue.state === "issue" ? "warning" : "primary", progress: radarr.queue.progress });
  return list;
}

/* ---------- Add ---------- */

/** Initial selections. Monitoring and search always start OFF; only the folder and profile may reuse the last choice. */
export function initialForm(options: RadarrOptions, remembered?: { rootFolderId?: unknown; qualityProfileId?: unknown } | null): AddForm {
  const usableFolders = options.rootFolders.filter(folder => folder.accessible);
  const rememberedFolder = usableFolders.find(folder => folder.id === remembered?.rootFolderId);
  const rememberedProfile = options.qualityProfiles.find(profile => profile.id === remembered?.qualityProfileId);
  return {
    rootFolderId: rememberedFolder ? rememberedFolder.id : usableFolders.length === 1 ? usableFolders[0].id : null,
    qualityProfileId: rememberedProfile ? rememberedProfile.id : options.qualityProfiles.length === 1 ? options.qualityProfiles[0].id : null,
    minimumAvailability: options.defaults.minimumAvailability,
    monitored: false,
    searchForMovie: false,
  };
}

/** Turning monitoring off also turns the search off: a search is only allowed for a monitored movie. */
export const setMonitored = (form: AddForm, monitored: boolean): AddForm => ({ ...form, monitored, searchForMovie: monitored ? form.searchForMovie : false });

/** Client-side validation mirrors the server's (which re-validates everything). */
export function validateForm(form: AddForm, options: RadarrOptions | null): string | null {
  if (!options) return "Loading Radarr options…";
  if (!options.rootFolders.some(folder => folder.accessible)) return "Radarr has no accessible root folder.";
  if (!options.qualityProfiles.length) return "Radarr has no quality profiles.";
  if (!options.rootFolders.some(folder => folder.accessible && folder.id === form.rootFolderId)) return "Choose a root folder.";
  if (!options.qualityProfiles.some(profile => profile.id === form.qualityProfileId)) return "Choose a quality profile.";
  if (!options.minimumAvailability.includes(form.minimumAvailability)) return "Choose a minimum availability.";
  if (form.searchForMovie && !form.monitored) return "Searching needs a monitored movie.";
  return null;
}

export function addRequest(form: AddForm, tmdbId: number) {
  return {
    tmdbId, rootFolderId: form.rootFolderId as number, qualityProfileId: form.qualityProfileId as number, minimumAvailability: form.minimumAvailability,
    monitored: form.monitored, searchForMovie: form.monitored && form.searchForMovie,
  };
}

export const availabilityLabels: Record<MinimumAvailability, string> = { announced: "Announced", inCinemas: "In cinemas", released: "Released" };

/** The add button says exactly what will happen. */
export const addActionLabel = (form: AddForm | null) => !form || !form.monitored ? "Add to Radarr" : form.searchForMovie ? "Add, monitor and search" : "Add and monitor";

export type AddResult = {
  added: true; monitored: boolean; monitoringAsRequested: boolean; search: "not_requested" | "started" | "failed" | "not_monitored" | "not_available";
  status: RadarrStatus; options: { rootFolder: string; qualityProfile: string; minimumAvailability: MinimumAvailability };
};

/** Toast after a confirmed addition: only what Radarr confirmed. */
export function addOutcome(result: AddResult): { tone: "success" | "warning"; title: string; lines: string[] } {
  const lines = [result.monitored ? "Monitored in Radarr." : "Not monitored: nothing will download yet."];
  if (!result.monitoringAsRequested) lines.push("Radarr did not store the monitoring you chose. Check the movie in Radarr.");
  if (result.search === "started") lines.push("Search started. Radarr grabs a release only if it finds a suitable one.");
  if (result.search === "failed") lines.push("Radarr could not start the search. Radarr will still look for the movie through its RSS feeds.");
  if (result.search === "not_available") lines.push("No search started: Radarr does not consider the movie available yet.");
  if (result.search === "not_monitored") lines.push("No search started because the movie is not monitored.");
  return { tone: result.monitoringAsRequested && result.search !== "failed" ? "success" : "warning", title: "Added to Radarr", lines };
}

/** Message for a failed addition, from the server's error code. */
export function addErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
  case "already_exists": return "This movie is already in Radarr.";
  case "in_progress": return "This movie is already being added. Please wait.";
  case "identity_changed": return "This movie's TMDB link changed. Nothing was added; please review it again.";
  case "unmatched": return "Radarr could not confirm this TMDB movie, so nothing was added.";
  case "invalid_root_folder": return "The selected root folder is not available in Radarr.";
  case "invalid_quality_profile": return "The selected quality profile does not exist in Radarr.";
  case "uncertain": return "Radarr did not confirm in time. The movie may still have been added: check again before retrying.";
  case "unverified": return "Radarr did not confirm the addition. Check Radarr before retrying.";
  case "timeout": return "Radarr did not respond in time. Try again in a moment.";
  case "unavailable": return "Radarr is unavailable right now. Try again in a moment.";
  case "rejected": return "Radarr rejected the addition. Nothing was added.";
  case "not_configured": return "Radarr is not configured on this server.";
  case "forbidden": return "Radarr is not available for this account.";
  case "invalid_request": return "Check the selected options and try again.";
  default: return status === 429 ? "Too many requests. Try again in a moment." : "Could not add the movie to Radarr. Nothing was changed in Cinetra.";
  }
}

/* ---------- Request Movie (already in Radarr) ---------- */

export const searchBlockMessages: Record<Exclude<SearchBlock, null>, string> = {
  on_disk: "The movie is already on disk. Cinetra never searches again, replaces or upgrades it.",
  unreleased: "Not released yet. Once monitored, Radarr grabs it when it becomes available.",
  unknown: "Radarr did not report whether the movie has a file, so no search is offered.",
  queued: "Radarr is already handling a download for this movie.",
  recently_searched: "Radarr searched for this movie a few minutes ago. Try again later.",
};

/** Exactly what confirming will do; mirrors the server, which re-checks Radarr's state and refuses any difference. */
export function requestPlan(view: RequestView, search: boolean) {
  const willSearch = search && view.canSearch;
  return { monitor: view.canMonitor, search: willSearch, nothing: !view.canMonitor && !willSearch };
}

export function requestProblem(view: RequestView | null, search: boolean): string | null {
  if (!view) return "Loading Radarr status…";
  if (view.fileState === "on_disk") return "The movie is already on disk. There is nothing to request.";
  if (requestPlan(view, search).nothing) return view.canSearch ? "Already monitored. Choose “Search now” to look for it immediately." : "Already monitored. There is nothing else to request right now.";
  return null;
}

export function requestBody(view: RequestView, search: boolean) {
  return { tmdbId: view.tmdbId, search: requestPlan(view, search).search, expected: { monitored: view.monitored, fileState: view.fileState } };
}

export const requestActionLabel = (plan: ReturnType<typeof requestPlan>) => plan.nothing ? "Nothing to request" : plan.monitor && plan.search ? "Confirm, monitor and search" : plan.search ? "Confirm and search" : "Confirm and monitor";

/** The panel's status after a confirmed request, from the fresh Radarr view the server returned. */
export const statusFromView = (view: RequestView): RadarrStatus => ({ state: "exists", movie: view.movie, radarrUrl: view.radarrUrl, radarr: { monitored: view.monitored, fileState: view.fileState, queue: view.queue, canSearch: view.canSearch } });

export function requestErrorMessage(code: string | undefined, status: number | undefined): string {
  switch (code) {
  case "state_changed": return "Radarr's state for this movie changed. Nothing was changed; review it and confirm again.";
  case "identity_changed": return "This movie's TMDB link changed. Nothing was changed; please review it again.";
  case "not_in_radarr": return "This movie is no longer in Radarr.";
  case "on_disk": return "This movie is already on disk in Radarr. Nothing was changed.";
  case "nothing_to_do": return "This movie is already monitored. Nothing was changed.";
  case "search_unavailable": return "A search is not possible for this movie right now. Nothing was searched.";
  case "recently_searched": return "Radarr searched for this movie a few minutes ago. Nothing was changed; try again later.";
  case "in_progress": return "Another Radarr change for this movie is in progress. Please wait.";
  case "not_applied": return "Radarr refused the change. Nothing was changed.";
  case "uncertain": return "Radarr did not confirm in time. The movie may be monitored: check again before retrying. No search was started.";
  case "unverified": return "Radarr did not confirm monitoring, so no search was started. Check again in a moment.";
  case "search_failed": return "Monitoring is on, but the search could not be confirmed. Radarr will still look for the movie through its RSS feeds.";
  case "timeout": return "Radarr did not respond in time. Try again in a moment.";
  case "unavailable": return "Radarr is unavailable right now. Try again in a moment.";
  case "not_configured": return "Radarr is not configured on this server.";
  case "forbidden": return "Radarr is not available for this account.";
  case "invalid_request": return "Check the request and try again.";
  default: return status === 429 ? "Too many requests. Try again in a moment." : "Could not update Radarr. Nothing was changed in Cinetra.";
  }
}

/** Errors after which Radarr's current state must be re-read before trying again (the search choice is reset). */
export const reloadAfter = (code: string | undefined) => ["state_changed", "uncertain", "unverified", "search_failed", "search_unavailable", "recently_searched", "identity_changed", "not_in_radarr", "on_disk", "nothing_to_do"].includes(code || "");

/* ---------- Small shared helpers (kept local so Radarr does not depend on the Sonarr module) ---------- */

/** Radarr may include the year in the title: don't show it twice. */
export const displayYear = (movie: Pick<MovieSummary, "title" | "year">) => movie.year && !movie.title.includes(`(${movie.year})`) ? movie.year : null;

export const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (match, key) => key in values ? String(values[key]) : match);

export function formatFreeSpace(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Per-session status cache: reopening a movie does not refetch at once. Failures and "unavailable" are not cached. */
export function createStatusCache(ttlMs = 60_000, now: () => number = Date.now) {
  const entries = new Map<string, { status: RadarrStatus; expires: number }>();
  return {
    get(movieId: string) { const hit = entries.get(movieId); return hit && hit.expires > now() ? hit.status : null; },
    set(movieId: string, status: RadarrStatus) {
      if (status.state === "unavailable") { entries.delete(movieId); return; }
      entries.set(movieId, { status, expires: now() + ttlMs });
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

/** Accepts a response only if it belongs to the latest request (stale answers never overwrite newer status). */
export function createLatest() {
  let current = 0;
  return { next: () => ++current, isLatest: (token: number) => token === current };
}
