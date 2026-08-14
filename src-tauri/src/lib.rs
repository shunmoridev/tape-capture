mod analysis;
mod commands;
mod infrastructure;
mod monitoring;
pub mod recording;

use std::sync::Arc;
use tauri::Manager;

#[cfg(target_os = "windows")]
const FFMPEG_NAME: &str = "ffmpeg.exe";
#[cfg(not(target_os = "windows"))]
const FFMPEG_NAME: &str = "ffmpeg";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let bundled = app
                .path()
                .resolve(
                    format!("resources/bin/{FFMPEG_NAME}"),
                    tauri::path::BaseDirectory::Resource,
                )
                .ok()
                .filter(|path| path.exists());
            infrastructure::ffmpeg::set_bundled_path(bundled);
            let analysis = Arc::new(analysis::AnalysisManager::default());
            let queue_state_path = app
                .path()
                .app_data_dir()
                .ok()
                .map(|directory| directory.join("finalization-queue.json"));
            let recording = Arc::new(match queue_state_path {
                Some(path) => recording::RecordingManager::with_recovery_queue(path),
                None => recording::RecordingManager::default(),
            });
            let monitoring = Arc::new(monitoring::MonitoringManager::default());
            let recovery_session = recording.last_queued_session();
            app.manage(Arc::clone(&recording));
            app.manage(analysis);
            app.manage(Arc::clone(&monitoring));
            if let Some(session_id) = recovery_session {
                infrastructure::recording_indicator::set(app.handle(), true);
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let worker = Arc::clone(&recording);
                    let _ =
                        tauri::async_runtime::spawn_blocking(move || worker.finish(&session_id))
                            .await;
                    infrastructure::recording_indicator::set(
                        &app_handle,
                        recording.is_active() || monitoring.status().running,
                    );
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::check_ffmpeg,
            commands::open_ffmpeg_download_page,
            commands::load_settings,
            commands::save_settings,
            commands::open_output_directory,
            commands::available_storage_bytes,
            commands::begin_recording,
            commands::append_recording_chunk,
            commands::mark_recording_end_boundary,
            commands::clear_recording_end_boundary,
            commands::seal_recording,
            commands::finish_recording,
            commands::recording_status,
            commands::analyze_capture_frame,
            commands::reset_capture_analysis,
            commands::start_monitoring,
            commands::observe_monitoring,
            commands::monitoring_manual_start,
            commands::monitoring_manual_stop,
            commands::monitoring_recording_started,
            commands::monitoring_recording_finalized,
            commands::monitoring_failed,
            commands::stop_monitoring,
            commands::monitoring_status,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| eprintln!("TapeCapture failed to start: {error}"));
}
