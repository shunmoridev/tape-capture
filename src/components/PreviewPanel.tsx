import type { MessageKey } from "../i18n";

interface Props {
  running: boolean;
  recording: boolean;
  audioAvailable: boolean;
  muted: boolean;
  volume: number;
  t: (key: MessageKey) => string;
  onStageElement: (element: HTMLDivElement | null) => void;
  onMutedChange: (muted: boolean) => void;
  onVolumeChange: (volume: number) => void;
  onVolumeCommit: (volume: number) => void;
}

export function PreviewPanel({
  running,
  recording,
  audioAvailable,
  muted,
  volume,
  t,
  onStageElement,
  onMutedChange,
  onVolumeChange,
  onVolumeCommit,
}: Props) {
  const normalizedVolume = Math.min(1, Math.max(0, volume));

  const toggleMuted = () => {
    const nextMuted = !muted;
    onMutedChange(nextMuted);
  };

  const updateVolume = (nextVolume: number) => {
    onVolumeChange(nextVolume);
  };

  return (
    <section className="preview-panel" aria-label={t("preview")}>
      <div ref={onStageElement} className={`preview-stage ${running ? "preview-stage--live" : ""}`}>
        {!running && (
          <div className="preview-placeholder">
            <svg viewBox="0 0 48 48" aria-hidden="true">
              <rect x="6" y="11" width="36" height="26" rx="4" />
              <path d="m19 19 12 5-12 5z" />
            </svg>
            <p>{t("previewPending")}</p>
          </div>
        )}
      </div>
      <div className="preview-controls">
        <span
          className={`preview-status ${running || recording ? "preview-status--running" : ""} ${recording ? "preview-status--recording" : ""}`}
          role="status"
        >
          {recording ? t("state_recording") : running ? t("inputPreviewLive") : t("analysisStopped")}
        </span>
        <div className="preview-audio-controls" aria-label={t("previewAudio")}>
          <button
            type="button"
            className={`preview-mute-button ${muted ? "preview-mute-button--muted" : ""}`}
            disabled={!audioAvailable}
            aria-label={t(muted ? "unmutePreview" : "mutePreview")}
            title={t(muted ? "unmutePreview" : "mutePreview")}
            aria-pressed={muted}
            onClick={toggleMuted}
          >
            <SpeakerIcon muted={muted} />
          </button>
          <label className="preview-volume-control">
            <span className="sr-only">{t("previewVolume")}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={normalizedVolume}
              disabled={!audioAvailable}
              aria-label={t("previewVolume")}
              onChange={(event) => updateVolume(Number(event.target.value))}
              onPointerUp={(event) => onVolumeCommit(Number(event.currentTarget.value))}
              onKeyUp={(event) => onVolumeCommit(Number(event.currentTarget.value))}
              onBlur={(event) => onVolumeCommit(Number(event.currentTarget.value))}
            />
            <output>{Math.round(normalizedVolume * 100)}%</output>
          </label>
        </div>
      </div>
    </section>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      {muted
        ? <path d="m16 9 4 6m0-6-4 6" />
        : <path d="M16 8.5a5 5 0 0 1 0 7" />}
    </svg>
  );
}
