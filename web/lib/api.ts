/**
 * Authenticated API client. Token refresh is single-flight so parallel 401
 * responses retry with one rotated token rather than racing or hanging.
 */
class ApiClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private refreshPromise: Promise<string> | null = null;
  private workspaceId = "default";
  private shareToken: string | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.accessToken = localStorage.getItem("ath_access_token");
      this.refreshToken = localStorage.getItem("ath_refresh_token");
      this.workspaceId = localStorage.getItem("ath_workspace_id") || "default";
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const queryParams = new URLSearchParams(window.location.search);
      const token = hashParams.get("workspace-share") || queryParams.get("workspace-share") || sessionStorage.getItem("ath_share_token");
      if (token) {
        this.shareToken = token;
        sessionStorage.setItem("ath_share_token", token);
      }
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

  getAccessToken() { return this.accessToken; }

  setWorkspaceId(id: string) {
    this.workspaceId = id || "default";
    if (typeof window !== "undefined") localStorage.setItem("ath_workspace_id", this.workspaceId);
  }

  getWorkspaceId() { return this.workspaceId; }

  getShareToken() { return this.shareToken; }

  clearShareToken() {
    this.shareToken = null;
    if (typeof window !== "undefined") sessionStorage.removeItem("ath_share_token");
  }

  private async refreshAccessToken(): Promise<string> {
    if (!this.refreshToken) throw new Error("Session expired. Sign in again.");
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        const response = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: this.refreshToken }),
        });
        if (!response.ok) throw new Error("Session refresh failed. Sign in again.");
        const data = await response.json().catch(() => ({}));
        if (!data.accessToken || !data.refreshToken) throw new Error("Invalid token refresh response.");
        this.setTokens(data.accessToken, data.refreshToken);
        return data.accessToken as string;
      })().finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const request = (token: string | null) => {
      const headers = new Headers(options.headers || {});
      if (token && !headers.has("Authorization")) headers.set("Authorization", "Bearer " + token);
      if (this.workspaceId && !headers.has("X-Workspace-Id")) headers.set("X-Workspace-Id", this.workspaceId);
      if (this.shareToken && !headers.has("X-ATH-Share-Token")) headers.set("X-ATH-Share-Token", this.shareToken);
      if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      return fetch(url, { ...options, headers });
    };

    let response = await request(this.accessToken);
    if (response.status !== 401 || !this.refreshToken) return response;
    try {
      const token = await this.refreshAccessToken();
      response = await request(token);
      if (response.status === 401) this.clearTokens();
      return response;
    } catch (error) {
      this.clearTokens();
      throw error;
    }
  }

  async json<T = any>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await this.fetchWithAuth(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.message || body.error || "Request failed (" + response.status + ")");
      (error as any).status = response.status;
      (error as any).payload = body;
      throw error;
    }
    return body as T;
  }
}

export const api = new ApiClient();
