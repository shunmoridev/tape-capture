import type { MessageKey } from "../i18n";

interface Props {
  checking: boolean;
  t: (key: MessageKey) => string;
  onDownload: () => void;
  onRecheck: () => void;
}

export function FfmpegRequirementNotice({
  checking,
  t,
  onDownload,
  onRecheck,
}: Props) {
  return (
    <section
      className="ffmpeg-notice"
      role="alert"
      aria-labelledby="ffmpeg-notice-title"
    >
      <span className="ffmpeg-notice__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M12 3 2.8 20h18.4L12 3Z" />
          <path d="M12 8.2v6.2" />
          <circle cx="12" cy="17.2" r=".8" />
        </svg>
      </span>
      <div className="ffmpeg-notice__copy">
        <strong id="ffmpeg-notice-title">{t("ffmpegMissingTitle")}</strong>
        <p>{t("ffmpegMissingDescription")}</p>
        <small>{t("ffmpegMissingPathHint")}</small>
      </div>
      <div className="ffmpeg-notice__actions">
        <button type="button" onClick={onDownload}>
          {t("ffmpegDownload")}
        </button>
        <button type="button" disabled={checking} onClick={onRecheck}>
          {checking ? t("ffmpegChecking") : t("ffmpegRecheck")}
        </button>
      </div>
    </section>
  );
}
