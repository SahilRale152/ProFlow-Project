const API_BASE =
  (typeof window !== "undefined" && (window as any).__NOVA_API_BASE__) ||
  import.meta.env.VITE_API_URL ||
  "http://localhost:5000";

const TOKEN_KEY = "nova_auth_token";

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearAuthToken() {
  if (typeof window !== "undefined") window.localStorage.removeItem(TOKEN_KEY);
}

export async function api(path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");

  const token = getAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok && response.status !== 304) {
    if (response.status === 401 && typeof window !== "undefined") {
      clearAuthToken();
    }
    throw new Error(body.message || body.error || `Request failed (${response.status})`);
  }

  return body;
}