import { clearUpcomingCache } from "@/lib/upcoming-cache";
import { ApiService } from "./api.service";

interface LoginCredentials {
  email: string;
  password: string;
}

interface SignupCredentials {
  username: string;
  email: string;
  password: string;
}

interface AuthResponse {
  token: string;
}

class AuthServiceClass extends ApiService {
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    const response = await this.post<AuthResponse>("/auth/login", credentials);
    
    if (response.data.token) {
      localStorage.setItem("Authorization", `Bearer ${response.data.token}`);
    }
    
    console.log("Login response data:", response.data);

    return response.data;
  }

  async signup(credentials: SignupCredentials): Promise<AuthResponse> {
    const response = await this.post<AuthResponse>("/auth/signup", credentials);
    
    if (response.data.token) {
      localStorage.setItem("Authorization", `Bearer ${response.data.token}`);
    }

    return response.data;
  }

  logout(): void {
    clearUpcomingCache();
    localStorage.removeItem("Authorization");
  }

  isAuthenticated(): boolean {
    return localStorage.getItem("Authorization") !== null;
  }
}

export const AuthService = new AuthServiceClass();
