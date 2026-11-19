import { ApiService } from "./api.service";
import type { AddResult, RadarrOptions, RadarrStatus, RequestView, addRequest, requestBody } from "@/lib/radarr";

export type RequestResult = { requested: true; monitoringEnabled: boolean; searched: boolean; view: RequestView };

/** Cinetra's backend only: the browser never talks to Radarr and never sees its credentials. */
class RadarrServiceClass extends ApiService {
  async getStatus(movieId: string, signal?: AbortSignal): Promise<RadarrStatus> {
    return (await this.api.get(`/radarr/movies/${encodeURIComponent(movieId)}`, { signal, timeout: 30_000 })).data;
  }
  async getOptions(signal?: AbortSignal): Promise<RadarrOptions> {
    return (await this.api.get("/radarr/options", { signal, timeout: 30_000 })).data;
  }
  /** Not routed through ApiService.post: Radarr changes no Cinetra data, so library caches stay valid. */
  async addMovie(movieId: string, body: ReturnType<typeof addRequest>): Promise<AddResult> {
    return (await this.api.post(`/radarr/movies/${encodeURIComponent(movieId)}`, body, { timeout: 60_000 })).data;
  }
  async getRequestView(movieId: string, signal?: AbortSignal): Promise<RequestView> {
    return (await this.api.get(`/radarr/movies/${encodeURIComponent(movieId)}/request`, { signal, timeout: 30_000 })).data;
  }
  async requestMovie(movieId: string, body: ReturnType<typeof requestBody>): Promise<RequestResult> {
    return (await this.api.post(`/radarr/movies/${encodeURIComponent(movieId)}/request`, body, { timeout: 60_000 })).data;
  }
}
export const RadarrService = new RadarrServiceClass();
