const API_BASE =
  (typeof window !== "undefined" && (window as any).__NOVA_API_BASE__) || "";

let installed = false;

async function report(payload: Record<string, unknown>) {
  try {
    await fetch(`${API_BASE}/api/admin/client-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        ...payload,
        url: typeof window !== "undefined" ? window.location.href : null,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      }),
    });
  } catch {
    // Never create a second error when diagnostics are unavailable.
  }
}

export function installClientErrorReporting() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("error", (event) => {
    void report({
      source: "window.onerror",
      message: event.message || "Unknown browser error",
      stack: event.error?.stack || null,
      line: event.lineno || null,
      column: event.colno || null,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    void report({
      source: "unhandledrejection",
      message: reason?.message || String(reason || "Unhandled promise rejection"),
      stack: reason?.stack || null,
    });
  });
}

installClientErrorReporting();
