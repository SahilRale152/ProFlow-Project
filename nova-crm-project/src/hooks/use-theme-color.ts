import { useCallback, useEffect, useState } from "react";

// Falls back to whatever the theme's own CSS variable currently resolves
// to (set in styles.css) when nothing has been chosen yet, so first-time
// users see the normal look.
function getDefaultColor(cssVar: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  const fromCss = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return fromCss || fallback;
}

function applyColor(cssVar: string, color: string) {
  document.documentElement.style.setProperty(cssVar, color);
}

/**
 * Reads/writes a single themeable color (background or foreground).
 * Persists to localStorage and applies it as a CSS variable on the root
 * element, which every themed surface in the app reads from.
 */
export function useThemeColor(cssVar: string, storageKey: string, fallback: string) {
  const [color, setColorState] = useState<string>(() => {
    if (typeof window === "undefined") return getDefaultColor(cssVar, fallback);
    return window.localStorage.getItem(storageKey) || getDefaultColor(cssVar, fallback);
  });

  // Apply on mount and whenever it changes.
  useEffect(() => {
    applyColor(cssVar, color);
  }, [cssVar, color]);

  const setColor = useCallback(
    (next: string) => {
      setColorState(next);
      window.localStorage.setItem(storageKey, next);
    },
    [storageKey],
  );

  const resetColor = useCallback(() => {
    window.localStorage.removeItem(storageKey);
    setColorState(getDefaultColor(cssVar, fallback));
  }, [cssVar, fallback]);

  return { color, setColor, resetColor };
}

export function useBackgroundColor() {
  const { color, setColor, resetColor } = useThemeColor("--background", "nova-crm-background-color", "#FFF5F8");
  return { color, setColor, resetColor };
}

export function useForegroundColor() {
  const { color, setColor, resetColor } = useThemeColor("--foreground", "nova-crm-foreground-color", "#3B0A22");
  return { color, setColor, resetColor };
}

export function useSidebarColor() {
  const { color, setColor, resetColor } = useThemeColor("--sidebar", "nova-crm-sidebar-color", "#FFFFFF");
  return { color, setColor, resetColor };
}

export function useSidebarForegroundColor() {
  const { color, setColor, resetColor } = useThemeColor(
    "--sidebar-foreground",
    "nova-crm-sidebar-foreground-color",
    "#3B0A22",
  );
  return { color, setColor, resetColor };
}