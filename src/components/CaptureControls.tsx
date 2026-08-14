import type { MessageKey } from "../i18n";
import type {
  MonitoringSnapshot,
  RecordingMode,
  RecordingSnapshot,
} from "../models";
import type { CaptureVideoFormat } from "../capture/captureProtocol";
import { InfoTip } from "./InfoTip";

interface DisplayedFile {
  label: string;
  path: string;
}

interface Props {
  runtime: RecordingSnapshot;
  monitoring: MonitoringSnapshot;
  recordingMode: RecordingMode;
  freeSpaceBytes: number | null;
  videoFormat: CaptureVideoFormat | null;
  displayedFile: DisplayedFile | null;
  canRecord: boolean;
  actionBusy: boolean;
  automaticPreparing: boolean;
  isRecording: boolean;
  isFinalizing: boolean;
  recordingSettingsDisabled: boolean;
  t: (key: MessageKey) => string;
  onRecordingModeChange: (mode: RecordingMode) => void;
  onPrimaryAction: () => void;
  onOpenRecordingSettings: () => void;
  onOpenOutputFolder: () => void;
}

export function CaptureControls({
  runtime,
  monitoring,
  recordingMode,
  freeSpaceBytes,
  videoFormat,
  displayedFile,
  canRecord,
  actionBusy,
  automaticPreparing,
  isRecording,
  isFinalizing,
  recordingSettingsDisabled,
  t,
  onRecordingModeChange,
  onPrimaryAction,
  onOpenRecordingSettings,
  onOpenOutputFolder,
}: Props) {
  const effectiveMode = monitoring.running ? "automatic" : recordingMode;
  const active = effectiveMode === "automatic" ? monitoring.running : isRecording;
  const monitoringDetail = effectiveMode === "manual"
    ? isFinalizing
      ? t("fileWriting")
      : actionBusy && !isRecording
        ? t("manualRecordingPreparing")
        : isRecording
          ? t("state_recording")
          : null
    : automaticPreparing
      ? t("automaticRecordingPreparing")
      : isFinalizing
        ? t("fileWriting")
      : monitoring.state === "stopConfirming"
          ? t("state_recording")
          : monitoring.state === "recording"
            ? t("state_recording")
            : monitoring.running
              ? runtime.filesCompleted > 0
                ? `${t("savedFiles")} ${runtime.filesCompleted}`
                : t("waitingForVideo")
              : null;
  const primaryLabel = automaticPreparing
    ? t("automaticRecordingPreparing")
    : isFinalizing && effectiveMode === "manual"
      ? t("fileWriting")
    : actionBusy && effectiveMode === "manual" && !isRecording
      ? t("manualRecordingPreparing")
      : active
        ? t(effectiveMode === "automatic" ? "stopMonitoring" : "manualStop")
        : t(effectiveMode === "automatic" ? "startMonitoring" : "manualStart");

  return (
    <>
      <div className="metrics-grid" aria-label={t("recordingMetrics")}>
        <div><span>{t("elapsed")}</span><strong>{formatDuration(runtime.elapsedMs)}</strong></div>
        <div><span>{t("inputVideoFormat")}</span><strong>{formatVideoFormat(videoFormat)}</strong></div>
        <div><span>{t("fileSize")}</span><strong>{formatBytes(runtime.currentFileSize)}</strong></div>
        <div><span>{t("freeSpace")}</span><strong>{freeSpaceBytes === null ? "—" : formatBytes(freeSpaceBytes)}</strong></div>
      </div>

      <div className="action-bar">
        <div className="recording-mode-control">
          <div className="recording-mode-select">
            <label htmlFor="recording-mode">{t("recordingMode")}</label>
            <select
              id="recording-mode"
              value={effectiveMode}
              disabled={actionBusy || monitoring.running || isRecording || isFinalizing}
              onChange={(event) => onRecordingModeChange(event.target.value as RecordingMode)}
            >
              <option value="automatic">{t("recordingModeAutomatic")}</option>
              <option value="manual">{t("recordingModeManual")}</option>
            </select>
          </div>
          <InfoTip
            label={t("recordingModeInformation")}
            boundary="setup-column"
          >
            <div className="option-guide">
              <p className="option-guide-intro">{t("recordingModeGuideIntro")}</p>
              <div className="option-guide-rows">
                <div className="option-guide-row">
                  <div><strong>{t("recordingModeAutomatic")}</strong></div>
                  <p>{t("recordingModeGuideAutomatic")}</p>
                </div>
                <div className="option-guide-row">
                  <div><strong>{t("recordingModeManual")}</strong></div>
                  <p>{t("recordingModeGuideManual")}</p>
                </div>
              </div>
            </div>
          </InfoTip>
        </div>
        <button
          type="button"
          className={`primary-action ${active ? "primary-action--active" : ""} ${automaticPreparing ? "primary-action--preparing" : ""}`}
          disabled={
            !canRecord
            || actionBusy
            || (isFinalizing && effectiveMode === "manual")
          }
          onClick={onPrimaryAction}
        >
          <span className="record-dot" aria-hidden="true" />
          <span className="action-copy">
            <strong>{primaryLabel}</strong>
            {monitoringDetail && <small>{monitoringDetail}</small>}
          </span>
        </button>
        <button
          type="button"
          className="recording-settings-button"
          disabled={recordingSettingsDisabled}
          aria-label={t("recordingSettings")}
          title={t("recordingSettings")}
          onClick={onOpenRecordingSettings}
        >
          <SlidersIcon />
        </button>
      </div>

      {displayedFile && (
        <div className="current-file">
          <span>{displayedFile.label}</span>
          <button
            type="button"
            className="open-folder-button"
            aria-label={t("openOutputFolder")}
            title={t("openOutputFolder")}
            onClick={onOpenOutputFolder}
          >
            <FolderIcon />
          </button>
          <b title={displayedFile.path}>{displayedFile.path}</b>
        </div>
      )}
      {runtime.pendingFinalizations > 0 && (
        <div className="finalization-status" role="status">
          <span className="finalization-status__pulse" aria-hidden="true" />
          <strong>{t("finalizationProcessing")}</strong>
          <span>
            {runtime.pendingFinalizations}
            {runtime.pendingFinalizations > 1
              ? ` · ${t("finalizationQueued")} ${runtime.pendingFinalizations - 1}`
              : ""}
          </span>
        </div>
      )}
      {runtime.lastError && <div className="inline-alert" role="alert">{runtime.lastError}</div>}
      {runtime.lastFinalizationError && (
        <div className="inline-warning" role="alert">
          <strong>{t("finalizationFailed")}</strong>
          <span>{runtime.lastFinalizationError}</span>
          {runtime.recoverableFile && <code>{runtime.recoverableFile}</code>}
        </div>
      )}
      {monitoring.lastError && <div className="inline-alert" role="alert">{monitoring.lastError}</div>}
    </>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h7" />
      <path d="M15 7h5" />
      <circle cx="13" cy="7" r="2" />
      <path d="M4 17h4" />
      <path d="M12 17h8" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 6.5h6l2 2h9v9.5H3.5z" />
      <path d="M3.5 8.5h17" />
    </svg>
  );
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function formatVideoFormat(format: CaptureVideoFormat | null): string {
  if (!format?.width || !format.height) return "—";
  const resolution = `${Math.round(format.width)}×${Math.round(format.height)}`;
  if (!format.frameRate) return `${resolution} · — fps`;
  const roundedFrameRate = Math.round(format.frameRate * 100) / 100;
  return `${resolution} · ${roundedFrameRate} fps`;
}
