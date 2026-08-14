import type { MessageKey } from "../i18n";
import type { AppSettings, CaptureDevice, CaptureVideoMode } from "../models";
import { AudioSourceSelector } from "./AudioSourceSelector";
import { InfoTip } from "./InfoTip";

interface Props {
  settings: AppSettings;
  videoDevices: CaptureDevice[];
  audioDevices: CaptureDevice[];
  effectiveAudioDeviceId: string | null;
  videoModes: CaptureVideoMode[];
  selectedVideoMode: CaptureVideoMode | null;
  loadingVideoModes: boolean;
  loadingDevices: boolean;
  locked: boolean;
  t: (key: MessageKey) => string;
  onRefresh: () => void;
  onVideoDeviceChange: (deviceId: string | null) => void;
  onVideoModeChange: (mode: CaptureVideoMode) => void;
  onAudioModeChange: (mode: AppSettings["audioSourceMode"]) => void;
  onAudioDeviceChange: (deviceId: string | null) => void;
  onChooseOutputDirectory: () => void;
  onOutputContainerChange: (container: AppSettings["outputContainer"]) => void;
  onQualityPresetChange: (preset: AppSettings["qualityPreset"]) => void;
}

export function CaptureSetupPanel({
  settings,
  videoDevices,
  audioDevices,
  effectiveAudioDeviceId,
  videoModes,
  selectedVideoMode,
  loadingVideoModes,
  loadingDevices,
  locked,
  t,
  onRefresh,
  onVideoDeviceChange,
  onVideoModeChange,
  onAudioModeChange,
  onAudioDeviceChange,
  onChooseOutputDirectory,
  onOutputContainerChange,
  onQualityPresetChange,
}: Props) {
  return (
    <section className="panel setup-panel" aria-labelledby="setup-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SETUP</p>
          <h2 id="setup-title">{t("setup")}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={loadingDevices}
          title={t("refresh")}
          aria-label={t("refresh")}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" />
            <path d="M20 5v6h-6" />
          </svg>
        </button>
      </div>

      <div className="field-stack">
        <label>
          <span>{t("videoDevice")}</span>
          <select
            disabled={locked}
            value={settings.videoDeviceId ?? ""}
            onChange={(event) => onVideoDeviceChange(event.target.value || null)}
          >
            <option value="">{videoDevices.length ? t("noDevice") : t("noDevicesFound")}</option>
            {videoDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}
          </select>
        </label>

        <label>
          <span>{t("videoMode")}</span>
          <select
            disabled={locked || !settings.videoDeviceId || loadingVideoModes || !videoModes.length}
            value={selectedVideoMode ? captureVideoModeKey(selectedVideoMode) : ""}
            onChange={(event) => {
              const selected = videoModes.find(
                (mode) => captureVideoModeKey(mode) === event.target.value,
              );
              if (selected) onVideoModeChange(selected);
            }}
          >
            {loadingVideoModes && <option value="">{t("checkingVideoModes")}</option>}
            {!loadingVideoModes && !videoModes.length && (
              <option value="">{t("noVideoModes")}</option>
            )}
            {videoModes.map((mode) => (
              <option key={captureVideoModeKey(mode)} value={captureVideoModeKey(mode)}>
                {captureVideoModeLabel(mode, t)}
              </option>
            ))}
          </select>
        </label>

        <AudioSourceSelector
          mode={settings.audioSourceMode}
          videoSelected={Boolean(settings.videoDeviceId)}
          audioDevices={audioDevices}
          selectedAudioId={effectiveAudioDeviceId}
          loading={loadingDevices}
          locked={locked}
          t={t}
          onModeChange={onAudioModeChange}
          onDeviceChange={onAudioDeviceChange}
        />

        <label>
          <span>{t("outputDirectory")}</span>
          <div className="path-picker">
            <input readOnly value={settings.outputDirectory} placeholder="C:\\Users\\…\\Videos" />
            <button type="button" disabled={locked} onClick={onChooseOutputDirectory}>{t("choose")}</button>
          </div>
        </label>

        <div className="field-pair">
          <div className="field-control">
            <div className="field-label-row">
              <label htmlFor="output-container">{t("outputContainer")}</label>
              <InfoTip
                label={t("moreInformation")}
              >
                <OptionGuide
                  intro={t("outputGuideIntro")}
                  recommendedLabel={t("recommended")}
                  rows={[
                    { id: "mkv", label: "MKV", description: t("outputGuideMkv"), recommended: true },
                    { id: "mp4", label: "MP4", description: t("outputGuideMp4") },
                  ]}
                />
              </InfoTip>
            </div>
            <select
              id="output-container"
              disabled={locked}
              value={settings.outputContainer}
              onChange={(event) => onOutputContainerChange(event.target.value as AppSettings["outputContainer"])}
            >
              <option value="mkv">{t("mkv")}</option>
              <option value="mp4">{t("mp4")}</option>
            </select>
          </div>

          <div className="field-control">
              <div className="field-label-row">
                <label htmlFor="quality-preset">{t("quality")}</label>
              <InfoTip label={t("moreInformation")}>
                <OptionGuide
                  intro={t("qualityGuideIntro")}
                  recommendedLabel={t("recommendedForVhs")}
                  rows={[
                    { id: "balanced", label: t("qualityStandard"), description: t("qualityGuideBalanced"), recommended: true },
                    { id: "archival", label: t("archival"), description: t("qualityGuideArchival") },
                    { id: "compact", label: t("compact"), description: t("qualityGuideCompact") },
                  ]}
                  note={t("qualityGuideEstimate")}
                />
              </InfoTip>
            </div>
            <select
              id="quality-preset"
              disabled={locked}
              value={settings.qualityPreset}
              onChange={(event) => onQualityPresetChange(event.target.value as AppSettings["qualityPreset"])}
            >
              <option value="balanced">{t("balanced")}</option>
              <option value="archival">{t("archival")}</option>
              <option value="compact">{t("compact")}</option>
            </select>
          </div>
        </div>
      </div>
    </section>
  );
}

function captureVideoModeKey(mode: CaptureVideoMode): string {
  return `${mode.width}x${mode.height}@${mode.frameRate.toFixed(2)}`;
}

function captureVideoModeLabel(
  mode: CaptureVideoMode,
  t: (key: MessageKey) => string,
): string {
  const prefix = mode.width === 720 && mode.height === 480
    ? t("ntscVideoMode")
    : (mode.width === 640 || mode.width === 480) && mode.height === 480
      ? t("sVhsVideoMode")
      : (mode.width === 352 || mode.width === 320) && mode.height === 240
        ? t("standardVhsVideoMode")
        : null;
  const roundedFrameRate = Math.abs(mode.frameRate - Math.round(mode.frameRate)) < 0.01
    ? String(Math.round(mode.frameRate))
    : mode.frameRate.toFixed(2);
  const details = `${mode.width}×${mode.height} / ${roundedFrameRate}fps`;
  return prefix ? `${prefix} — ${details}` : details;
}

interface OptionGuideRow {
  id: string;
  label: string;
  description: string;
  recommended?: boolean;
}

function OptionGuide({
  intro,
  rows,
  recommendedLabel,
  note,
}: {
  intro: string;
  rows: OptionGuideRow[];
  recommendedLabel: string;
  note?: string;
}) {
  return (
    <div className="option-guide">
      <p className="option-guide-intro">{intro}</p>
      <div className="option-guide-rows">
        {rows.map((row) => (
          <div className="option-guide-row" key={row.id}>
            <div>
              <strong>{row.label}</strong>
              {row.recommended && <span>{recommendedLabel}</span>}
            </div>
            <p>{row.description}</p>
          </div>
        ))}
      </div>
      {note && <small className="option-guide-note">{note}</small>}
    </div>
  );
}
