/**
 * API Client with Automatic Access & Refresh Token Interceptor
 *
 * Implements silent token rotation:
 * 1. Attaches Bearer Access Token to all outgoing requests
 * 2. On 401 Unauthorized, automatically calls POST /api/auth/refresh
 * 3. Rotates tokens and transparently retries original request
 */

class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private isRefreshing = false;
  private refreshSubscribers: ((token: string) => void)[] = [];

  constructor() {
    if (typeof window !== "undefined") {
      this.accessToken = localStorage.getItem("ath_access_token");
      this.refreshToken = localStorage.getItem("ath_refresh_token");
    }
  }

  setTokens(access: string, refresh: string) {
    this.accessToken = access;
    this.refreshToken = refresh;
    if (typeof window !== "undefined") {
      localStorage.setItem("ath_access_token", access);
      localStorage.setItem("ath_refresh_token", refresh);
    }
  }

  clearTokens() {
    this.accessToken = null;
    this.refreshToken = null;
    if (typeof window !== "undefined") {
      localStorage.removeItem("ath_access_token");
      localStorage.removeItem("ath_refresh_token");
    }
  }

  getAccessToken() {
    return this.accessToken;
  }

  async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers || {});

    if (this.accessToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    }

    if (!headers.has("Content-Type") && !(options.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }

    let response = await fetch(url, { ...options, headers });

    // Auto-refresh token if 401 Unauthorized
    if (response.status === 401 && this.refreshToken) {
      if (!this.isRefreshing) {
        this.isRefreshing = true;
        try {
          const newTokens = await this.refreshTokens();
          this.isRefreshing = false;
          this.onRefreshed(newTokens.accessToken);
        } catch (err) {
          this.isRefreshing = false;
          this.clearTokens();
          throw err;
        }
      }

      // Wait for active refresh
      return new Promise<Response>((resolve) => {
        this.subscribeTokenRefresh((newToken: string) => {
          headers.set("Authorization", `Bearer ${newToken}`);
          resolve(fetch(url, { ...options, headers }));
        });
      });
    }

    return response;
  }

  private subscribeTokenRefresh(cb: (token: string) => void) {
    this.refreshSubscribers.push(cb);
  }

  private onRefreshed(token: string) {
    this.refreshSubscribers.forEach((cb) => cb(token));
    this.refreshSubscribers = [];
  }

  private async refreshTokens(): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });

    if (!res.ok) {
      throw new Error("Failed to refresh session");
    }

    const data = await res.json();
    this.setTokens(data.accessToken, data.refreshToken);
    return data;
  }
}

export const api = new ApiClient();
