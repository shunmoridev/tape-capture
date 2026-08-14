import type { ThemePreference } from "./models";

const STORAGE_KEY = "tapecapture-theme";

export function getThemePreference(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

export function applyTheme(preference: ThemePreference): void {
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(STORAGE_KEY);
  } else {
    document.documentElement.dataset.theme = preference;
    localStorage.setItem(STORAGE_KEY, preference);
  }
}

export function initTheme(): void {
  applyTheme(getThemePreference());
}
