import type { MessageKey } from "../i18n";
import type { AudioSourceMode, CaptureDevice } from "../models";

interface Props {
  mode: AudioSourceMode;
  videoSelected: boolean;
  audioDevices: CaptureDevice[];
  selectedAudioId: string | null;
  loading: boolean;
  locked: boolean;
  t: (key: MessageKey) => string;
  onModeChange: (mode: AudioSourceMode) => void;
  onDeviceChange: (deviceId: string | null) => void;
}

const choices: Array<{
  mode: AudioSourceMode;
  title: MessageKey;
  description: MessageKey;
}> = [
  { mode: "auto", title: "autoAudioTitle", description: "autoAudioDescription" },
  { mode: "manual", title: "manualAudioTitle", description: "manualAudioDescription" },
  { mode: "none", title: "noAudioTitle", description: "noAudioDescription" },
];

export function AudioSourceSelector({
  mode,
  videoSelected,
  audioDevices,
  selectedAudioId,
  loading,
  locked,
  t,
  onModeChange,
  onDeviceChange,
}: Props) {
  const selectedAudio = audioDevices.find((device) => device.id === selectedAudioId) ?? null;
  const autoStatus = !videoSelected
    ? { text: t("chooseVideoFirst"), warning: false }
    : loading
      ? { text: t("autoPairSearching"), warning: false }
    : selectedAudio
      ? { text: `${t("autoSelectedAudio")}: ${selectedAudio.name}`, warning: false }
      : { text: t("autoPairNotFound"), warning: true };

  return (
    <fieldset className="audio-source" disabled={locked}>
      <legend>{t("audioDevice")}</legend>
      <div className="audio-mode-grid">
        {choices.map((choice) => (
          <label
            className={`audio-mode-card ${mode === choice.mode ? "audio-mode-card--selected" : ""}`}
            key={choice.mode}
          >
            <input
              type="radio"
              name="audio-source-mode"
              value={choice.mode}
              checked={mode === choice.mode}
              onChange={() => onModeChange(choice.mode)}
            />
            <span className="audio-mode-copy">
              <strong>{t(choice.title)}</strong>
              <small>{t(choice.description)}</small>
            </span>
            {choice.mode === "auto" && <span className="recommended-badge">{t("recommended")}</span>}
          </label>
        ))}
      </div>

      {mode === "auto" && (
        <div className={`auto-audio-status ${autoStatus.warning ? "auto-audio-status--warning" : ""}`}>
          <span className="auto-audio-status-dot" aria-hidden="true" />
          {autoStatus.text}
        </div>
      )}

      {mode === "manual" && (
        <label className="audio-device-select">
          <span>{t("fixedAudio")}</span>
          <select
            disabled={locked}
            value={selectedAudioId ?? ""}
            onChange={(event) => onDeviceChange(event.target.value || null)}
          >
            <option value="">{audioDevices.length ? t("noDevice") : t("noDevicesFound")}</option>
            {audioDevices.map((device) => (
              <option key={device.id} value={device.id}>{device.name}</option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}
