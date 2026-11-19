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
export type AddForm = { rootFolderId: number | null; qualityProfileId: number | null; monitor: MonitorOption; monitorNewItems: MonitorNewItems; searchForMissingEpisodes: boolean };

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

export const monitorLabels: Record<MonitorOption, string> = {
  none: "None", future: "Future episodes", missing: "Missing episodes", existing: "Existing episodes", recent: "Recent episodes",
  pilot: "Pilot episode", firstSeason: "First season", lastSeason: "Last season", all: "All episodes",
};
export const monitorDescriptions: Record<MonitorOption, string> = {
  none: "Nothing is monitored. Sonarr will not search for or download any episode.",
  future: "Episodes that haven't aired yet.",
  missing: "Released episodes without files, and future episodes.",
  existing: "Episodes that already have files, and future episodes.",
  recent: "Episodes aired in the last 90 days, and future episodes.",
  pilot: "Only the first episode of the series.",
  firstSeason: "Every episode of the first season.",
  lastSeason: "Every episode of the latest season.",
  all: "Every episode except specials.",
};

/** Initial selections. Monitoring always starts at the safe defaults; folders/profiles may reuse the last choice. */
export function initialForm(options: SonarrOptions, remembered?: { rootFolderId?: unknown; qualityProfileId?: unknown } | null): AddForm {
  const usableFolders = options.rootFolders.filter(folder => folder.accessible);
  const rememberedFolder = usableFolders.find(folder => folder.id === remembered?.rootFolderId);
  const rememberedProfile = options.qualityProfiles.find(profile => profile.id === remembered?.qualityProfileId);
  return {
    rootFolderId: rememberedFolder ? rememberedFolder.id : usableFolders.length === 1 ? usableFolders[0].id : null,
    qualityProfileId: rememberedProfile ? rememberedProfile.id : options.qualityProfiles.length === 1 ? options.qualityProfiles[0].id : null,
    monitor: options.defaults.monitor,
    monitorNewItems: options.defaults.monitorNewItems,
    searchForMissingEpisodes: options.defaults.searchForMissingEpisodes,
  };
}

/** Client-side validation mirrors the server's (which re-validates everything). */
export function validateForm(form: AddForm, options: SonarrOptions | null): string | null {
  if (!options) return "Loading Sonarr options…";
  if (!options.rootFolders.some(folder => folder.accessible)) return "Sonarr has no accessible root folder.";
  if (!options.qualityProfiles.length) return "Sonarr has no quality profiles.";
  if (!options.rootFolders.some(folder => folder.accessible && folder.id === form.rootFolderId)) return "Choose a root folder.";
  if (!options.qualityProfiles.some(profile => profile.id === form.qualityProfileId)) return "Choose a quality profile.";
  if (!options.monitorOptions.includes(form.monitor)) return "Choose a monitoring option.";
  if (form.searchForMissingEpisodes && form.monitor === "none") return "Searching needs monitored episodes.";
  return null;
}

/** Changing monitoring to "none" switches off searching (it would find nothing). */
export function withMonitor(form: AddForm, monitor: MonitorOption): AddForm {
  return { ...form, monitor, searchForMissingEpisodes: monitor === "none" ? false : form.searchForMissingEpisodes };
}

/** True when the confirmation may lead to downloads, now or later, through Sonarr's existing configuration. */
export const mayDownload = (form: AddForm) => form.monitor !== "none" || form.monitorNewItems === "all" || form.searchForMissingEpisodes;

export function addRequest(form: AddForm, tvdbId: number) {
  return { tvdbId, rootFolderId: form.rootFolderId as number, qualityProfileId: form.qualityProfileId as number, monitor: form.monitor, monitorNewItems: form.monitorNewItems, searchForMissingEpisodes: form.searchForMissingEpisodes };
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
