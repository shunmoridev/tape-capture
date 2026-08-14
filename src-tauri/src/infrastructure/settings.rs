use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub video_device_id: Option<String>,
    pub audio_device_id: Option<String>,
    pub audio_source_mode: AudioSourceMode,
    pub audio_device_mappings: HashMap<String, String>,
    pub video_mode_mappings: HashMap<String, CaptureVideoMode>,
    pub output_directory: String,
    pub output_container: OutputContainer,
    pub quality_preset: QualityPreset,
    pub recording_mode: RecordingMode,
    pub theme: ThemePreference,
    pub language: Language,
    pub start_confirmation_ms: u64,
    pub stop_confirmation_ms: u64,
    pub analysis_interval_ms: u64,
    pub pre_roll_ms: u64,
    pub preview_muted: bool,
    pub preview_volume: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureVideoMode {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OutputContainer {
    Mkv,
    Mp4,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum QualityPreset {
    Archival,
    Balanced,
    Compact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RecordingMode {
    Automatic,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AudioSourceMode {
    Auto,
    Manual,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Ja,
    En,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            video_device_id: None,
            audio_device_id: None,
            audio_source_mode: AudioSourceMode::Auto,
            audio_device_mappings: HashMap::new(),
            video_mode_mappings: HashMap::new(),
            output_directory: String::new(),
            output_container: OutputContainer::Mkv,
            quality_preset: QualityPreset::Balanced,
            recording_mode: RecordingMode::Automatic,
            theme: ThemePreference::System,
            language: Language::Ja,
            start_confirmation_ms: 1_500,
            stop_confirmation_ms: 10_000,
            analysis_interval_ms: 300,
            pre_roll_ms: 5_000,
            preview_muted: true,
            preview_volume: 0.7,
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("settings.json"))
        .map_err(|error| format!("Could not resolve the settings directory: {error}"))
}

pub fn load(app: &AppHandle) -> Result<AppSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let json =
        fs::read_to_string(&path).map_err(|error| format!("Could not read settings: {error}"))?;
    serde_json::from_str(&json).map_err(|error| format!("The settings file is invalid: {error}"))
}

pub fn save(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "The settings path has no parent directory.".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the settings directory: {error}"))?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Could not serialize settings: {error}"))?;
    fs::write(path, json).map_err(|error| format!("Could not save settings: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_mvp_timing() {
        let settings = AppSettings::default();
        assert_eq!(settings.start_confirmation_ms, 1_500);
        assert_eq!(settings.stop_confirmation_ms, 10_000);
        assert_eq!(settings.recording_mode, RecordingMode::Automatic);
        assert_eq!(settings.analysis_interval_ms, 300);
        assert_eq!(settings.pre_roll_ms, 5_000);
        assert!(settings.preview_muted);
        assert_eq!(settings.preview_volume, 0.7);
        assert_eq!(settings.output_container, OutputContainer::Mkv);
        assert_eq!(settings.audio_source_mode, AudioSourceMode::Auto);
        assert!(settings.video_mode_mappings.is_empty());
    }

    #[test]
    fn older_settings_without_audio_mode_are_migrated_to_auto() {
        let json = r#"{
            "videoDeviceId": "video-1",
            "audioDeviceId": "audio-1",
            "outputDirectory": "C:\\captures",
            "outputContainer": "mkv",
            "qualityPreset": "balanced",
            "theme": "system",
            "language": "ja",
            "startConfirmationMs": 1500,
            "stopConfirmationMs": 10000,
            "analysisIntervalMs": 300
        }"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.audio_source_mode, AudioSourceMode::Auto);
        assert_eq!(settings.recording_mode, RecordingMode::Automatic);
        assert!(settings.audio_device_mappings.is_empty());
        assert!(settings.video_mode_mappings.is_empty());
        assert_eq!(settings.pre_roll_ms, 5_000);
        assert!(settings.preview_muted);
        assert_eq!(settings.preview_volume, 0.7);
    }
}
