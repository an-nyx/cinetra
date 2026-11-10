import { ApiService } from "./api.service";

export type NotificationPreferences = { newEpisodes: boolean; movies: boolean; dailyDigest: boolean; showScope: "all_except_dropped" };
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
  async sendTest(endpoint: string): Promise<void> {
    await this.api.post("/notifications/test", { endpoint });
  }
}
export const NotificationService = new NotificationServiceClass();
