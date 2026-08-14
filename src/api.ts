import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  BeginRecordingResponse,
  FfmpegStatus,
  FrameFeatures,
  MonitoringDecision,
  MonitoringSnapshot,
  RecordingSnapshot,
} from "./models";

export async function checkFfmpeg(): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>("check_ffmpeg");
}

export async function openFfmpegDownloadPage(): Promise<void> {
  await invoke("open_ffmpeg_download_page");
}

export async function loadSettings(): Promise<AppSettings> {
  return invoke<AppSettings>("load_settings");
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", { settings });
}

export async function openOutputDirectory(): Promise<void> {
  await invoke("open_output_directory");
}

export async function getAvailableStorageBytes(path: string): Promise<number> {
  return invoke<number>("available_storage_bytes", { path });
}

export async function beginRecording(
  settings: AppSettings,
  mimeType: string,
): Promise<BeginRecordingResponse> {
  return invoke<BeginRecordingResponse>("begin_recording", {
    request: {
      outputDirectory: settings.outputDirectory,
      outputContainer: settings.outputContainer,
      qualityPreset: settings.qualityPreset,
      mimeType,
    },
  });
}

export async function appendRecordingChunk(
  sessionId: string,
  chunk: Uint8Array,
): Promise<RecordingSnapshot> {
  return invoke<RecordingSnapshot>("append_recording_chunk", chunk, {
    headers: { "x-tapecapture-session": sessionId },
  });
}

export async function markRecordingEndBoundary(sessionId: string): Promise<void> {
  await invoke("mark_recording_end_boundary", { sessionId });
}

export async function clearRecordingEndBoundary(sessionId: string): Promise<void> {
  await invoke("clear_recording_end_boundary", { sessionId });
}

export async function finishRecording(sessionId: string): Promise<RecordingSnapshot> {
  return invoke<RecordingSnapshot>("finish_recording", { sessionId });
}

export async function sealRecording(sessionId: string): Promise<RecordingSnapshot> {
  return invoke<RecordingSnapshot>("seal_recording", { sessionId });
}

export async function getRecordingStatus(): Promise<RecordingSnapshot> {
  return invoke<RecordingSnapshot>("recording_status");
}

export async function analyzeCaptureFrame(
  rgba: Uint8Array,
  width: number,
  height: number,
  audioRmsDb: number | null,
): Promise<FrameFeatures> {
  const headers: Record<string, string> = {
    "x-frame-width": String(width),
    "x-frame-height": String(height),
  };
  if (audioRmsDb !== null) headers["x-audio-rms-db"] = String(audioRmsDb);
  return invoke<FrameFeatures>("analyze_capture_frame", rgba, { headers });
}

export async function resetCaptureAnalysis(): Promise<void> {
  await invoke("reset_capture_analysis");
}

export async function startMonitoringState(
  settings: AppSettings,
): Promise<MonitoringSnapshot> {
  return invoke<MonitoringSnapshot>("start_monitoring", {
    request: {
      startConfirmationMs: settings.startConfirmationMs,
      stopConfirmationMs: settings.stopConfirmationMs,
      analysisIntervalMs: settings.analysisIntervalMs,
      preRollMs: settings.preRollMs,
    },
  });
}

export async function observeMonitoring(contentActive: boolean): Promise<MonitoringDecision> {
  return invoke<MonitoringDecision>("observe_monitoring", { contentActive });
}

export async function monitoringManualStart(): Promise<MonitoringDecision> {
  return invoke<MonitoringDecision>("monitoring_manual_start");
}

export async function monitoringManualStop(): Promise<MonitoringDecision> {
  return invoke<MonitoringDecision>("monitoring_manual_stop");
}

export async function monitoringRecordingStarted(): Promise<MonitoringSnapshot> {
  return invoke<MonitoringSnapshot>("monitoring_recording_started");
}

export async function monitoringRecordingFinalized(): Promise<MonitoringSnapshot> {
  return invoke<MonitoringSnapshot>("monitoring_recording_finalized");
}

export async function monitoringFailed(error: string): Promise<MonitoringSnapshot> {
  return invoke<MonitoringSnapshot>("monitoring_failed", { error });
}

export async function stopMonitoringState(): Promise<MonitoringSnapshot> {
  return invoke<MonitoringSnapshot>("stop_monitoring");
}

export async function getMonitoringStatus(): Promise<MonitoringSnapshot> {
  return invoke<MonitoringSnapshot>("monitoring_status");
}
