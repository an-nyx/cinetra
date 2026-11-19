import { ApiService } from "./api.service";
import type { addRequest, MonitorOption, MonitorNewItems, SonarrOptions, SonarrStatus } from "@/lib/sonarr";

export type AddResult = { added: true; status: SonarrStatus; options: { monitor: MonitorOption; monitorNewItems: MonitorNewItems; searchForMissingEpisodes: boolean; rootFolder: string; qualityProfile: string } };

/** Cinetra's backend only: the browser never talks to Sonarr and never sees its credentials. */
class SonarrServiceClass extends ApiService {
  async getStatus(showId: string, signal?: AbortSignal): Promise<SonarrStatus> {
    return (await this.api.get(`/sonarr/shows/${encodeURIComponent(showId)}`, { signal, timeout: 30_000 })).data;
  }
  async getOptions(): Promise<SonarrOptions> {
    return (await this.api.get("/sonarr/options", { timeout: 30_000 })).data;
  }
  /** Not routed through ApiService.post: adding to Sonarr changes no Cinetra data, so library caches stay valid. */
  async addSeries(showId: string, body: ReturnType<typeof addRequest>): Promise<AddResult> {
    return (await this.api.post(`/sonarr/shows/${encodeURIComponent(showId)}`, body, { timeout: 60_000 })).data;
  }
}
export const SonarrService = new SonarrServiceClass();
