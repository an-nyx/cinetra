import { ApiService } from "./api.service";

export type NotificationPreferences = { newEpisodes: boolean; movies: boolean; dailyDigest: boolean; showScope: "all_except_dropped" };
export type SchedulerStatus = {
  enabled: boolean; configured: boolean; configError: string | null; running: boolean; intervalMinutes: number;
  startedAt: string | null; nextTickAt: string | null; ticks: number; lastTickStartedAt: string | null; lastTickFinishedAt: string | null;
  lastTickDurationMs: number | null; lastError: { at: string; message: string } | null;
  lastRun: { startedAt: string; users: number; devices: number; showsChecked: number; verifiedShows: number; unverifiedShows: number; unavailableShows: number; premiered: number; alreadyWatched: number; beforeOptIn: number; ledgerCreated: number; delivered: number; gone: number; retry: number; failed: number; uncertain: number; skipped: number; expired: number } | null;
};
export type ShowDiagnostic = {
  showId: string; name: string; status: string | null; eligible: boolean;
  reason: "dropped" | "no_tmdb_link" | "unverified" | "unavailable" | "shared_tvmaze_identity" | null; detail: string | null;
  tvmazeId: number | null; tvmazeStatus: string | null; timeZone: string | null; stale: boolean;
  lastPremiere: { season: number; number: number; airdate: string | null; premieredAt: string; timing: string; watched: boolean; withinLookback: boolean } | null;
  nextEpisode: { season: number; number: number; airdate: string | null; airtime: string | null; airstamp: string | null; premieresAt: string | null } | null;
};
export type NotificationDiagnostics = {
  generatedAt: string; scheduler: SchedulerStatus; preferences: NotificationPreferences;
  devices: { id: string; createdAt: string; notifyFrom: string; updatedAt: string; lastSuccessAt: string | null; lastFailureAt: string | null; failureCount: number; userAgent: string | null }[];
  shows: { total: number; eligible: number; dropped: number; noTmdbLink: number; unverified: number; unavailable: number; sharedIdentity: number; recentPremieres: number; items: ShowDiagnostic[] };
  deliveries: { id: string; deviceId: string; showId: string; showName: string | null; season: number; episode: number; premieredAt: string; status: string; attempts: number; lastError: string | null; sentAt: string | null; createdAt: string; updatedAt: string }[];
};
export type DeviceRegistration = { registered: boolean; subscriptionId: string | null; notifyFrom: string | null; lastSuccessAt: string | null; failureCount: number };

/** Push settings. The endpoint is always sent in a request body (never a URL), and is never returned by the server. */
class NotificationServiceClass extends ApiService {
  async getConfig(): Promise<{ configured: boolean; vapidPublicKey: string | null }> {
    return (await this.api.get("/notifications/config")).data;
  }
  async getPreferences(): Promise<{ preferences: NotificationPreferences; devices: number }> {
    return (await this.api.get("/notifications/preferences")).data;
  }
  async setNewEpisodes(newEpisodes: boolean): Promise<NotificationPreferences> {
    return (await this.api.put("/notifications/preferences", { newEpisodes })).data.preferences;
  }
  async saveSubscription(subscription: PushSubscriptionJSON): Promise<DeviceRegistration> {
    return (await this.api.post("/notifications/subscriptions", { subscription })).data;
  }
  async deviceStatus(endpoint: string): Promise<DeviceRegistration> {
    return (await this.api.post("/notifications/subscriptions/status", { endpoint })).data;
  }
  async removeSubscription(endpoint: string): Promise<void> {
    await this.api.delete("/notifications/subscriptions", { data: { endpoint } });
  }
  /** Why each show would or would not alert, this account's devices and delivery history. Cold caches can take a while. */
  async getDiagnostics(): Promise<NotificationDiagnostics> {
    return (await this.api.get("/notifications/diagnostics", { timeout: 90_000 })).data;
  }
  async sendTest(endpoint: string): Promise<void> {
    await this.api.post("/notifications/test", { endpoint });
  }
}
export const NotificationService = new NotificationServiceClass();
