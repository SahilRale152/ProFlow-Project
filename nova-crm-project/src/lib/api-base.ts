/**
 * Single source of truth for "where is the backend?"
 *
 * Resolution order:
 *   1. window.__NOVA_API_BASE__  — runtime override, set this from a
 *      <script> tag if you ever need to point one deployed build at a
 *      different backend without rebuilding.
 *   2. import.meta.env.VITE_API_URL — build-time env var. Set this in
 *      Render (or your .env for local prod-style testing) to the
 *      backend's URL, e.g. https://proflow-backend-q7ig.onrender.com
 *   3. "" — empty string, i.e. same-origin relative requests. This is
 *      what makes plain `localhost` dev work (Vite's dev proxy, or a
 *      single combined server) without any env var set at all.
 *
 * IMPORTANT: never fall back to a hardcoded "http://localhost:5000"
 * here. If VITE_API_URL isn't set in production, that fallback makes
 * every visitor's browser try to reach their OWN machine's port 5000
 * instead of your real backend — it fails silently for everyone but
 * you. Falling back to "" instead means requests go to same-origin,
 * which is the correct behavior whether that's right or still missing
 * a proxy — it fails loudly (404) rather than silently.
 */
export const API_BASE: string =
  (typeof window !== "undefined" && (window as any).__NOVA_API_BASE__) ||
  (import.meta as any).env?.VITE_API_URL ||
  "";
