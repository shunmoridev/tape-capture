import type { Language, ThemePreference } from "../models";

export const RECORDING_SETTINGS_WEBVIEW_LABEL = "recording-settings-overlay";
export const RECORDING_SETTINGS_READY_EVENT = "tapecapture://recording-settings-ready";
export const RECORDING_SETTINGS_STATE_EVENT = "tapecapture://recording-settings-state";
export const RECORDING_SETTINGS_SAVE_EVENT = "tapecapture://recording-settings-save";
export const RECORDING_SETTINGS_CLOSE_EVENT = "tapecapture://recording-settings-close";

// Product-facing limits are intentionally narrower than the authoritative
// safety envelope in src-tauri/src/monitoring/manager.rs.
export const RECORDING_SETTING_LIMITS = {
  startConfirmationMs: { min: 500, max: 5_000, step: 100 },
  stopConfirmationMs: { min: 2_000, max: 30_000, step: 1_000 },
  preRollMs: { min: 0, max: 10_000, step: 1_000 },
  analysisIntervalMs: { min: 200, max: 1_000, step: 100 },
} as const;

export interface RecordingSettingsValues {
  startConfirmationMs: number;
  stopConfirmationMs: number;
  preRollMs: number;
  analysisIntervalMs: number;
}

export interface RecordingSettingsOverlayState extends RecordingSettingsValues {
  language: Language;
  theme: ThemePreference;
}
