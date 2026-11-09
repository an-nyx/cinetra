import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";

export class ApiService {
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
    return this.api.get<T>(url, config);
  }

  protected async post<T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.api.post<T>(url, data, config);
  }

  protected async put<T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.api.put<T>(url, data, config);
  }

  protected async delete<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.api.delete<T>(url, config);
  }

  protected async patch<T>(
    url: string,
    data?: unknown,
    config?: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    return this.api.patch<T>(url, data, config);
  }
}
