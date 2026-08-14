use crate::analysis::{AnalysisManager, FrameFeatures};
use crate::infrastructure::ffmpeg::{self, FfmpegStatus};
use crate::infrastructure::settings::{self, AppSettings};
use crate::monitoring::{
    MonitoringDecision, MonitoringManager, MonitoringSnapshot, StartMonitoringRequest,
};
use crate::recording::{
    BeginRecordingResponse, RecordingManager, RecordingSnapshot, StartRecordingRequest,
};
use std::sync::Arc;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn check_ffmpeg() -> FfmpegStatus {
    tauri::async_runtime::spawn_blocking(ffmpeg::status)
        .await
        .unwrap_or_else(|error| FfmpegStatus {
            available: false,
            version: None,
            source: None,
            error: Some(format!("FFmpeg check failed: {error}")),
        })
}

#[tauri::command]
pub fn open_ffmpeg_download_page(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url("https://ffmpeg.org/download.html", None::<&str>)
        .map_err(|error| format!("Could not open the FFmpeg download page: {error}"))
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    settings::load(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    settings::save(&app, &settings)
}

#[tauri::command]
pub fn open_output_directory(app: AppHandle) -> Result<(), String> {
    let output_directory = settings::load(&app)?.output_directory;
    if output_directory.trim().is_empty() {
        return Err("The output directory is not configured.".to_owned());
    }
    let path = std::path::PathBuf::from(&output_directory);
    if !path.is_dir() {
        return Err(format!(
            "The output directory does not exist or is unavailable: {output_directory}"
        ));
    }
    app.opener()
        .open_path(output_directory, None::<&str>)
        .map_err(|error| format!("Could not open the output directory: {error}"))
}

#[tauri::command]
pub fn available_storage_bytes(path: String) -> Result<u64, String> {
    crate::infrastructure::storage::available_bytes(&path)
}

#[tauri::command]
pub fn begin_recording(
    app: AppHandle,
    manager: State<'_, Arc<RecordingManager>>,
    request: StartRecordingRequest,
) -> Result<BeginRecordingResponse, String> {
    let response = manager.begin(request)?;
    crate::infrastructure::recording_indicator::set(&app, true);
    Ok(response)
}

#[tauri::command]
pub async fn append_recording_chunk(
    request: Request<'_>,
    manager: State<'_, Arc<RecordingManager>>,
) -> Result<RecordingSnapshot, String> {
    let session_id = required_header(&request, "x-tapecapture-session")?.to_owned();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Recording chunks must use a raw binary IPC body.".to_owned());
    };
    let bytes = bytes.to_vec();
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.append(&session_id, &bytes))
        .await
        .map_err(|error| format!("Recording write task failed: {error}"))?
}

#[tauri::command]
pub fn mark_recording_end_boundary(
    manager: State<'_, Arc<RecordingManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.mark_automatic_end_boundary(&session_id)
}

#[tauri::command]
pub fn clear_recording_end_boundary(
    manager: State<'_, Arc<RecordingManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.clear_automatic_end_boundary(&session_id)
}

#[tauri::command]
pub async fn seal_recording(
    manager: State<'_, Arc<RecordingManager>>,
    session_id: String,
) -> Result<RecordingSnapshot, String> {
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || manager.seal(&session_id))
        .await
        .map_err(|error| format!("Recording seal task failed: {error}"))?
}

#[tauri::command]
pub async fn finish_recording(
    app: AppHandle,
    manager: State<'_, Arc<RecordingManager>>,
    monitoring: State<'_, Arc<MonitoringManager>>,
    session_id: String,
) -> Result<RecordingSnapshot, String> {
    let manager = Arc::clone(manager.inner());
    let manager_for_status = Arc::clone(&manager);
    let result = tauri::async_runtime::spawn_blocking(move || manager.finish(&session_id))
        .await
        .map_err(|error| format!("Recording finalization task failed: {error}"))?;
    let indicator_active = manager_for_status.is_active() || monitoring.status().running;
    crate::infrastructure::recording_indicator::set(&app, indicator_active);
    result
}

#[tauri::command]
pub fn recording_status(manager: State<'_, Arc<RecordingManager>>) -> RecordingSnapshot {
    manager.snapshot()
}

#[tauri::command]
pub async fn analyze_capture_frame(
    request: Request<'_>,
    manager: State<'_, Arc<AnalysisManager>>,
) -> Result<FrameFeatures, String> {
    let width = parse_header::<usize>(&request, "x-frame-width")?;
    let height = parse_header::<usize>(&request, "x-frame-height")?;
    let audio_rms_db = optional_header(&request, "x-audio-rms-db")
        .map(|value| {
            value
                .parse::<f64>()
                .map_err(|_| "The audio RMS header is invalid.".to_owned())
        })
        .transpose()?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Analysis frames must use a raw binary IPC body.".to_owned());
    };
    let bytes = bytes.to_vec();
    let manager = Arc::clone(manager.inner());
    tauri::async_runtime::spawn_blocking(move || {
        manager.analyze_rgba(&bytes, width, height, audio_rms_db)
    })
    .await
    .map_err(|error| format!("Capture analysis task failed: {error}"))?
}

#[tauri::command]
pub fn reset_capture_analysis(manager: State<'_, Arc<AnalysisManager>>) {
    manager.reset();
}

#[tauri::command]
pub fn start_monitoring(
    app: AppHandle,
    manager: State<'_, Arc<MonitoringManager>>,
    analysis: State<'_, Arc<AnalysisManager>>,
    request: StartMonitoringRequest,
) -> Result<MonitoringSnapshot, String> {
    analysis.reset();
    let snapshot = manager.start(request)?;
    crate::infrastructure::recording_indicator::set(&app, true);
    Ok(snapshot)
}

#[tauri::command]
pub fn observe_monitoring(
    manager: State<'_, Arc<MonitoringManager>>,
    content_active: bool,
) -> Result<MonitoringDecision, String> {
    manager.observe(content_active)
}

#[tauri::command]
pub fn monitoring_manual_start(
    manager: State<'_, Arc<MonitoringManager>>,
) -> Result<MonitoringDecision, String> {
    manager.manual_start()
}

#[tauri::command]
pub fn monitoring_manual_stop(
    manager: State<'_, Arc<MonitoringManager>>,
) -> Result<MonitoringDecision, String> {
    manager.manual_stop()
}

#[tauri::command]
pub fn monitoring_recording_started(
    manager: State<'_, Arc<MonitoringManager>>,
) -> Result<MonitoringSnapshot, String> {
    manager.recording_started()
}

#[tauri::command]
pub fn monitoring_recording_finalized(
    manager: State<'_, Arc<MonitoringManager>>,
) -> Result<MonitoringSnapshot, String> {
    manager.recording_finalized()
}

#[tauri::command]
pub fn monitoring_failed(
    app: AppHandle,
    manager: State<'_, Arc<MonitoringManager>>,
    recording: State<'_, Arc<RecordingManager>>,
    error: String,
) -> MonitoringSnapshot {
    let snapshot = manager.fail(error);
    crate::infrastructure::recording_indicator::set(&app, recording.is_active());
    snapshot
}

#[tauri::command]
pub fn stop_monitoring(
    app: AppHandle,
    manager: State<'_, Arc<MonitoringManager>>,
    recording: State<'_, Arc<RecordingManager>>,
    analysis: State<'_, Arc<AnalysisManager>>,
) -> Result<MonitoringSnapshot, String> {
    analysis.reset();
    let snapshot = manager.stop()?;
    crate::infrastructure::recording_indicator::set(&app, recording.is_active());
    Ok(snapshot)
}

#[tauri::command]
pub fn monitoring_status(manager: State<'_, Arc<MonitoringManager>>) -> MonitoringSnapshot {
    manager.status()
}

fn required_header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    optional_header(request, name).ok_or_else(|| format!("Missing required header: {name}"))
}

fn optional_header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

fn parse_header<T>(request: &Request<'_>, name: &str) -> Result<T, String>
where
    T: std::str::FromStr,
{
    required_header(request, name)?
        .parse::<T>()
        .map_err(|_| format!("Invalid header: {name}"))
}
