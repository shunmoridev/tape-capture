import type { Language, ThemePreference } from "../models";

export const SETTINGS_WEBVIEW_LABEL = "settings-overlay";
export const SETTINGS_READY_EVENT = "tapecapture://settings-ready";
export const SETTINGS_STATE_EVENT = "tapecapture://settings-state";
export const SETTINGS_CHANGE_EVENT = "tapecapture://settings-change";
export const SETTINGS_CLOSE_EVENT = "tapecapture://settings-close";
export const DISMISS_OVERLAYS_EVENT = "tapecapture://dismiss-overlays";

export interface SettingsOverlayState {
  language: Language;
  theme: ThemePreference;
}

export type SettingsOverlayChange =
  | { key: "language"; value: Language }
  | { key: "theme"; value: ThemePreference };
