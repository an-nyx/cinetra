import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";

const cache = new Map<string, { expires: number; promise: Promise<AxiosResponse<unknown>> }>();
let generation = 0;

export class ApiService {
  static clearCache() { generation++; cache.clear(); }
  protected api: AxiosInstance;
  protected baseURL: string;

  constructor() {
    this.baseURL = `${import.meta.env.VITE_API_PATH || ""}/api/v1`;
    
    this.api = axios.create({
      baseURL: this.baseURL,
      timeout: 20000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    // Add request interceptor to attach authorization token
    this.api.interceptors.request.use(
      (config) => {
        const token = localStorage.getItem("Authorization");
        if (token) {
          config.headers.Authorization = token;
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      },
    );

    // Add response interceptor for error handling
    this.api.interceptors.response.use(
      (response) => response,
      (error) => {
        // Handle common errors here if needed
        if (error.response?.status === 401) {
          // Token expired or invalid
          localStorage.removeItem("Authorization");
          window.location.href = "/login";
        }
        return Promise.reject(error);
      },
    );
  }

  protected async get<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    const ttl = url === "/show/upcoming" ? 120_000 : ["/show", "/show/tracking", "/movie"].includes(url) ? 15_000 : 0;
    if (!ttl || config?.signal || config?.params) return this.api.get<T>(url, config);
    const key = `${localStorage.getItem("Authorization") || ""}:${url}`;
    const existing = cache.get(key);
    if (existing && existing.expires > Date.now()) return existing.promise as Promise<AxiosResponse<T>>;
    const currentGeneration = generation;
    const promise = this.api.get<T>(url, config).then(response => {
      if (currentGeneration === generation && cache.get(key)?.promise === promise) cache.set(key, { expires: Date.now() + ttl, promise });
      return response;
    }).catch(error => { if (cache.get(key)?.promise === promise) cache.delete(key); throw error; });
    cache.set(key, { expires: Infinity, promise });
    return promise;
  }

  protected async post<T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    ApiService.clearCache();
    return this.api.post<T>(url, data, config);
  }

  protected async put<T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    ApiService.clearCache();
    return this.api.put<T>(url, data, config);
  }

  protected async delete<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    ApiService.clearCache();
    return this.api.delete<T>(url, config);
  }

  protected async patch<T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    ApiService.clearCache();
    return this.api.patch<T>(url, data, config);
  }
}
