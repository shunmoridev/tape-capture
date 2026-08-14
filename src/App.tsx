import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { checkFfmpeg, getAvailableStorageBytes, getMonitoringStatus, getRecordingStatus, loadSettings, openFfmpegDownloadPage, openOutputDirectory, saveSettings } from "./api";
import { captureBridge } from "./capture/captureBridge";
import type { CaptureVideoFormat } from "./capture/captureProtocol";
import { BrandMark } from "./components/BrandMark";
import { BuildInfo } from "./components/BuildInfo";
import { CaptureControls } from "./components/CaptureControls";
import { CaptureSetupPanel } from "./components/CaptureSetupPanel";
import { FfmpegRequirementNotice } from "./components/FfmpegRequirementNotice";
import { PreviewPanel } from "./components/PreviewPanel";
import { SettingsMenu } from "./components/SettingsMenu";
import { translate, type MessageKey } from "./i18n";
import { recordingSettingsOverlay } from "./recordingSettings/recordingSettingsOverlay";
import {
  RECORDING_SETTINGS_CLOSE_EVENT,
  RECORDING_SETTINGS_READY_EVENT,
  RECORDING_SETTINGS_SAVE_EVENT,
  RECORDING_SETTING_LIMITS,
  type RecordingSettingsOverlayState,
  type RecordingSettingsValues,
} from "./recordingSettings/recordingSettingsProtocol";
import { DISMISS_OVERLAYS_EVENT } from "./settings/settingsProtocol";
import {
  DEFAULT_SETTINGS,
  EMPTY_MONITORING,
  type AppSettings,
  type CaptureDevice,
  type CaptureVideoMode,
  type FfmpegStatus,
  type MonitoringSnapshot,
  type RecordingSnapshot,
} from "./models";
import { applyTheme } from "./theme";

function captureVideoModeKey(mode: CaptureVideoMode | null): string {
  return mode ? `${mode.width}x${mode.height}@${mode.frameRate.toFixed(2)}` : "auto";
}

function sameCaptureVideoMode(
  left: CaptureVideoMode | null | undefined,
  right: CaptureVideoMode | null | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.width === right.width
    && left.height === right.height
    && Math.abs(left.frameRate - right.frameRate) < 0.3,
  );
}

function recordingSettingsState(settings: AppSettings): RecordingSettingsOverlayState {
  return {
    language: settings.language,
    theme: settings.theme,
    startConfirmationMs: settings.startConfirmationMs,
    stopConfirmationMs: settings.stopConfirmationMs,
    preRollMs: settings.preRollMs,
    analysisIntervalMs: settings.analysisIntervalMs,
  };
}

function normalizeRecordingSettings(values: RecordingSettingsValues): RecordingSettingsValues {
  const limits = RECORDING_SETTING_LIMITS;
  return {
    startConfirmationMs: clampAndRound(
      values.startConfirmationMs,
      limits.startConfirmationMs.min,
      limits.startConfirmationMs.max,
      limits.startConfirmationMs.step,
    ),
    stopConfirmationMs: clampAndRound(
      values.stopConfirmationMs,
      limits.stopConfirmationMs.min,
      limits.stopConfirmationMs.max,
      limits.stopConfirmationMs.step,
    ),
    preRollMs: clampAndRound(
      values.preRollMs,
      limits.preRollMs.min,
      limits.preRollMs.max,
      limits.preRollMs.step,
    ),
    analysisIntervalMs: clampAndRound(
      values.analysisIntervalMs,
      limits.analysisIntervalMs.min,
      limits.analysisIntervalMs.max,
      limits.analysisIntervalMs.step,
    ),
  };
}

function clampAndRound(value: number, minimum: number, maximum: number, step: number): number {
  const finiteValue = Number.isFinite(value) ? value : minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(finiteValue / step) * step));
}

const MAX_AUTOMATIC_PREVIEW_RETRIES = 4;

function App() {
  const isTauri = "__TAURI_INTERNALS__" in window;
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [devices, setDevices] = useState<CaptureDevice[]>([]);
  const [videoModes, setVideoModes] = useState<CaptureVideoMode[]>([]);
  const [loadingVideoModes, setLoadingVideoModes] = useState(false);
  const [ffmpeg, setFfmpeg] = useState<FfmpegStatus | null>(null);
  const [ffmpegChecking, setFfmpegChecking] = useState(false);
  const [runtime, setRuntime] = useState<RecordingSnapshot>({
    state: "idle",
    elapsedMs: 0,
    currentFile: null,
    nextFile: null,
    currentFileSize: 0,
    lastError: null,
    pendingFinalizations: 0,
    finalizationActive: false,
    filesCompleted: 0,
    finalizationFailures: 0,
    lastFinalizationError: null,
    recoverableFile: null,
  });
  const [monitoring, setMonitoring] = useState<MonitoringSnapshot>(EMPTY_MONITORING);
  const [previewLive, setPreviewLive] = useState(false);
  const [previewAudioAvailable, setPreviewAudioAvailable] = useState(false);
  const [previewVideoFormat, setPreviewVideoFormat] = useState<CaptureVideoFormat | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const previewGenerationRef = useRef(0);
  const previewFailureRef = useRef({ key: "", count: 0 });
  const [monitoringOperation, setMonitoringOperation] = useState<"starting" | "stopping" | null>(null);
  const [manualBusy, setManualBusy] = useState(false);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [devicesReady, setDevicesReady] = useState(false);
  const [freeSpaceBytes, setFreeSpaceBytes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordingSettingsOpen, setRecordingSettingsOpen] = useState(false);
  const settingsRef = useRef(settings);
  const recordingSettingsOpenRef = useRef(false);
  settingsRef.current = settings;

  const t = useCallback(
    (key: MessageKey) => translate(settings.language, key),
    [settings.language],
  );

  const closeRecordingSettings = useCallback(() => {
    recordingSettingsOpenRef.current = false;
    setRecordingSettingsOpen(false);
    if (isTauri) {
      void recordingSettingsOverlay.close().catch((cause) => setError(String(cause)));
    }
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let cleanup: UnlistenFn[] = [];
    void Promise.all([
      listen(RECORDING_SETTINGS_READY_EVENT, () => {
        if (recordingSettingsOpenRef.current) {
          void recordingSettingsOverlay.sync(recordingSettingsState(settingsRef.current))
            .catch((cause) => setError(String(cause)));
        }
      }),
      listen<RecordingSettingsValues>(RECORDING_SETTINGS_SAVE_EVENT, ({ payload }) => {
        const values = normalizeRecordingSettings(payload);
        setSettings((current) => {
          const next = { ...current, ...values };
          void saveSettings(next).catch((cause) => {
            setError(`${translate(current.language, "settingsSaveFailed")} ${String(cause)}`);
          });
          return next;
        });
        closeRecordingSettings();
      }),
      listen(RECORDING_SETTINGS_CLOSE_EVENT, closeRecordingSettings),
    ]).then((unlisteners) => {
      if (active) cleanup = unlisteners;
      else unlisteners.forEach((unlisten) => unlisten());
    }).catch((cause) => setError(String(cause)));
    void recordingSettingsOverlay.close().catch(() => undefined);
    return () => {
      active = false;
      cleanup.forEach((unlisten) => unlisten());
      void recordingSettingsOverlay.close().catch(() => undefined);
    };
  }, [closeRecordingSettings, isTauri]);

  const videoDevices = useMemo(() => devices.filter((device) => device.kind === "video"), [devices]);
  const audioDevices = useMemo(() => devices.filter((device) => device.kind === "audio"), [devices]);
  const selectedVideo = useMemo(
    () => videoDevices.find((device) => device.id === settings.videoDeviceId) ?? null,
    [settings.videoDeviceId, videoDevices],
  );
  const selectedVideoMode = settings.videoDeviceId
    ? settings.videoModeMappings[settings.videoDeviceId] ?? null
    : null;
  const savedPairedAudioDeviceId = settings.videoDeviceId
    ? settings.audioDeviceMappings[settings.videoDeviceId] ?? null
    : null;
  const pairedAudioDeviceId = audioDevices.some(
    (device) => device.id === savedPairedAudioDeviceId,
  )
    ? savedPairedAudioDeviceId
    : selectedVideo?.suggestedAudioDeviceId ?? null;
  const effectiveAudioDeviceId = settings.audioSourceMode === "none"
    ? null
    : settings.audioSourceMode === "manual"
      ? settings.audioDeviceId
      : pairedAudioDeviceId;
  const selectedAudio = useMemo(
    () => audioDevices.find((device) => device.id === effectiveAudioDeviceId) ?? null,
    [audioDevices, effectiveAudioDeviceId],
  );
  const isRecording = runtime.state === "recording" || runtime.state === "stopConfirming";
  const isFinalizing = runtime.state === "finalizing" || monitoring.state === "finalizing";
  const refreshDevices = useCallback(async () => {
    setLoadingDevices(true);
    setError(null);
    try {
      setDevices(await captureBridge.listMediaDevices());
    } catch (cause) {
      setError(`${t("deviceLoadFailed")} ${String(cause)}`);
    } finally {
      setLoadingDevices(false);
      setDevicesReady(true);
    }
  }, [t]);

  const refreshFfmpeg = useCallback(async () => {
    if (!isTauri) return;
    setFfmpegChecking(true);
    try {
      setFfmpeg(await checkFfmpeg());
    } catch (cause) {
      setFfmpeg({ available: false, error: String(cause) });
      setError(`${t("ffmpegCheckFailed")} ${String(cause)}`);
    } finally {
      setFfmpegChecking(false);
    }
  }, [isTauri, t]);

  const handleOpenFfmpegDownload = useCallback(async () => {
    try {
      await openFfmpegDownloadPage();
    } catch (cause) {
      setError(`${t("ffmpegDownloadOpenFailed")} ${String(cause)}`);
    }
  }, [t]);

  useEffect(() => {
    if (!isTauri) {
      setFfmpeg({ available: false, source: "web-preview" });
      return;
    }
    let active = true;
    void loadSettings()
      .then((saved) => {
        if (!active) return;
        setSettings(saved);
        applyTheme(saved.theme);
      })
      .catch((cause) => active && setError(String(cause)))
      .finally(() => {
        if (active) setSettingsReady(true);
      });
    setFfmpegChecking(true);
    void checkFfmpeg()
      .then((status) => active && setFfmpeg(status))
      .catch((cause) => {
        if (!active) return;
        setFfmpeg({ available: false, error: String(cause) });
      })
      .finally(() => {
        if (active) setFfmpegChecking(false);
      });
    return () => { active = false; };
  }, [isTauri]);

  useEffect(() => {
    if (isTauri) void refreshDevices();
  }, [isTauri, refreshDevices]);

  useEffect(() => {
    if (
      !isTauri
      || settings.audioSourceMode !== "auto"
      || !settings.videoDeviceId
      || !pairedAudioDeviceId
      || settings.audioDeviceMappings[settings.videoDeviceId] === pairedAudioDeviceId
    ) return;
    setSettings((current) => {
      if (!current.videoDeviceId || current.audioSourceMode !== "auto") return current;
      const next = {
        ...current,
        audioDeviceMappings: {
          ...current.audioDeviceMappings,
          [current.videoDeviceId]: pairedAudioDeviceId,
        },
      };
      void saveSettings(next).catch(() => undefined);
      return next;
    });
  }, [isTauri, pairedAudioDeviceId, settings.audioDeviceMappings, settings.audioSourceMode, settings.videoDeviceId]);

  useEffect(() => {
    const savedVideoId = settings.videoDeviceId;
    if (!isTauri || !savedVideoId || !devices.length) return;
    if (devices.some((device) => device.kind === "video" && device.id === savedVideoId)) return;
    const availableVideo = devices.filter((device) => device.kind === "video");
    const captureName = /usb video|video capture|capture card|grabber|vhs/i;
    const suggested = availableVideo.length === 1
      ? availableVideo[0]
      : availableVideo.find((device) => captureName.test(device.name)) ?? null;
    const next = {
      ...settings,
      videoDeviceId: suggested?.id ?? null,
      audioDeviceId: null,
      audioDeviceMappings: suggested?.suggestedAudioDeviceId
        ? {
            ...settings.audioDeviceMappings,
            [suggested.id]: suggested.suggestedAudioDeviceId,
          }
        : settings.audioDeviceMappings,
    };
    setSettings(next);
    void saveSettings(next).catch(() => undefined);
  }, [devices, isTauri, settings]);

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    const refreshRuntime = () => {
      void getRecordingStatus().then((snapshot) => {
        if (!active) return;
        setRuntime(snapshot);
      }).catch(() => undefined);
      void getMonitoringStatus().then(setMonitoring).catch(() => undefined);
    };
    refreshRuntime();
    const runtimePoll = window.setInterval(refreshRuntime, 500);
    return () => {
      active = false;
      window.clearInterval(runtimePoll);
    };
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri || !settings.outputDirectory) {
      setFreeSpaceBytes(null);
      return;
    }
    const refresh = () => {
      void getAvailableStorageBytes(settings.outputDirectory)
        .then(setFreeSpaceBytes)
        .catch(() => setFreeSpaceBytes(null));
    };
    refresh();
    const interval = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(interval);
  }, [isTauri, settings.outputDirectory]);

  useEffect(() => {
    if (!isTauri || !settingsReady || !devicesReady) return;

    const generation = ++previewGenerationRef.current;
    const videoDeviceId = selectedVideo?.id ?? null;
    const audioDeviceId = selectedAudio?.id ?? null;
    const previewKey = `${videoDeviceId ?? ""}\n${audioDeviceId ?? ""}\n${captureVideoModeKey(selectedVideoMode)}`;
    if (previewFailureRef.current.key !== previewKey) {
      previewFailureRef.current = { key: previewKey, count: 0 };
      setPreviewError(null);
    }
    setPreviewVideoFormat(null);
    setLoadingVideoModes(Boolean(videoDeviceId));
    void (async () => {
      if (generation !== previewGenerationRef.current) return;
      try {
        if (!videoDeviceId) {
          await captureBridge.closeStream().catch(() => undefined);
          setPreviewLive(false);
          setPreviewAudioAvailable(false);
          setPreviewVideoFormat(null);
          setVideoModes([]);
          previewFailureRef.current = { key: previewKey, count: 0 };
          setPreviewError(null);
          return;
        }
        const preview = await captureBridge.open(videoDeviceId, audioDeviceId, selectedVideoMode);
        if (generation !== previewGenerationRef.current) return;
        setVideoModes(preview.supportedVideoModes);
        setPreviewLive(preview.running);
        setPreviewAudioAvailable(preview.audioAvailable);
        setPreviewVideoFormat({
          width: preview.width,
          height: preview.height,
          frameRate: preview.frameRate,
        });
        await captureBridge.setPreviewAudio(
          settings.previewMuted ?? true,
          settings.previewVolume ?? 0.7,
        );
        if (generation !== previewGenerationRef.current) return;
        previewFailureRef.current = { key: previewKey, count: 0 };
        setPreviewError(null);
        if (
          preview.selectedVideoMode
          && !sameCaptureVideoMode(selectedVideoMode, preview.selectedVideoMode)
        ) {
          setSettings((current) => {
            if (current.videoDeviceId !== videoDeviceId) return current;
            const savedMode = current.videoModeMappings[videoDeviceId];
            if (sameCaptureVideoMode(savedMode, preview.selectedVideoMode)) return current;
            const next = {
              ...current,
              videoModeMappings: {
                ...current.videoModeMappings,
                [videoDeviceId]: preview.selectedVideoMode as CaptureVideoMode,
              },
            };
            void saveSettings(next).catch(() => undefined);
            return next;
          });
        }
      } catch (cause) {
        if (generation === previewGenerationRef.current) {
          setPreviewLive(false);
          setPreviewAudioAvailable(false);
          setPreviewVideoFormat(null);
          const failure = previewFailureRef.current;
          const failureCount = failure.key === previewKey ? failure.count + 1 : 1;
          previewFailureRef.current = { key: previewKey, count: failureCount };
          if (failureCount >= 2) {
            setPreviewError(`${t("analysisStartFailed")} ${String(cause)}`);
          }
          if (failureCount <= MAX_AUTOMATIC_PREVIEW_RETRIES) {
            const retryDelay = Math.min(8_000, 500 * (2 ** (failureCount - 1)));
            window.setTimeout(() => {
              if (generation === previewGenerationRef.current) {
                setPreviewRefresh((value) => value + 1);
              }
            }, retryDelay);
          }
        }
      } finally {
        if (generation === previewGenerationRef.current) setLoadingVideoModes(false);
      }
    })();
  }, [
    devicesReady,
    isTauri,
    previewRefresh,
    selectedAudio?.id,
    selectedVideo?.id,
    selectedVideoMode?.frameRate,
    selectedVideoMode?.height,
    selectedVideoMode?.width,
    settingsReady,
    t,
  ]);

  useEffect(() => {
    const videoDeviceId = selectedVideo?.id ?? null;
    if (!isTauri || !previewLive || !videoDeviceId) return;

    let active = true;
    const refreshPreviewStatus = () => {
      void captureBridge.getPreviewStatus()
        .then((preview) => {
          if (!active || preview.videoDeviceId !== videoDeviceId) return;
          setPreviewLive(preview.running);
          setPreviewAudioAvailable(preview.audioAvailable);
          setPreviewVideoFormat({
            width: preview.width,
            height: preview.height,
            frameRate: preview.frameRate,
          });
        })
        .catch(() => undefined);
    };
    refreshPreviewStatus();
    const interval = window.setInterval(refreshPreviewStatus, 1_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [isTauri, previewLive, selectedVideo?.id]);

  const updateSettings = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    if (key === "theme") applyTheme(value as AppSettings["theme"]);
  };

  const persistSettings = async (nextSettings = settings) => {
    if (!isTauri) return;
    setError(null);
    try {
      await saveSettings(nextSettings);
    } catch (cause) {
      setError(`${t("settingsSaveFailed")} ${String(cause)}`);
    }
  };

  const updateAndPersistSettings = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    if (key === "theme") applyTheme(value as AppSettings["theme"]);
    void persistSettings(next);
  };

  const chooseOutputDirectory = async () => {
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false, title: t("outputDirectory") });
      if (typeof selected !== "string") return;
      const next = { ...settings, outputDirectory: selected };
      setSettings(next);
      await persistSettings(next);
    } catch (cause) {
      setError(`${t("folderPickFailed")} ${String(cause)}`);
    }
  };
  const inputConfigured = Boolean(
    settings.videoDeviceId
      && (settings.audioSourceMode === "none" || effectiveAudioDeviceId),
  );
  const canRecord = Boolean(ffmpeg?.available && inputConfigured && settings.outputDirectory);
  const monitoringBusy = monitoringOperation !== null;
  const settingsLocked = monitoringBusy
    || manualBusy
    || monitoring.running
    || isRecording
    || isFinalizing;
  const handleOpenRecordingSettings = async () => {
    if (!isTauri || settingsLocked || recordingSettingsOpenRef.current) return;
    setError(null);
    recordingSettingsOpenRef.current = true;
    setRecordingSettingsOpen(true);
    try {
      await emit(DISMISS_OVERLAYS_EVENT);
      await recordingSettingsOverlay.open(recordingSettingsState(settingsRef.current));
    } catch (cause) {
      closeRecordingSettings();
      setError(String(cause));
    }
  };
  const handleManualStart = async () => {
    setError(null);
    setManualBusy(true);
    try {
      setRuntime(await captureBridge.startManual(settings));
    }
    catch (cause) {
      setError(`${t("recordingStartFailed")} ${String(cause)}`);
      setPreviewRefresh((value) => value + 1);
    } finally {
      setManualBusy(false);
    }
  };
  const handleStop = async () => {
    setError(null);
    setManualBusy(true);
    try {
      setRuntime(await captureBridge.stopRecording());
    } catch (cause) {
      setError(`${t("recordingStopFailed")} ${String(cause)}`);
    } finally {
      setManualBusy(false);
    }
  };
  const handleAudioModeChange = (mode: AppSettings["audioSourceMode"]) => {
    const next = { ...settings, audioSourceMode: mode };
    setSettings(next);
    void persistSettings(next);
  };
  const handleVideoDeviceChange = (videoDeviceId: string | null) => {
    setVideoModes([]);
    const next = { ...settings, videoDeviceId };
    setSettings(next);
    void persistSettings(next);
  };
  const handleVideoModeChange = (videoMode: CaptureVideoMode) => {
    if (!settings.videoDeviceId) return;
    const next = {
      ...settings,
      videoModeMappings: {
        ...settings.videoModeMappings,
        [settings.videoDeviceId]: videoMode,
      },
    };
    setSettings(next);
    void persistSettings(next);
  };
  const handleAudioDeviceChange = (deviceId: string | null) => {
    const next = settings.audioSourceMode === "auto" && settings.videoDeviceId
      ? {
          ...settings,
          audioDeviceMappings: deviceId
            ? { ...settings.audioDeviceMappings, [settings.videoDeviceId]: deviceId }
            : Object.fromEntries(
                Object.entries(settings.audioDeviceMappings)
                  .filter(([videoId]) => videoId !== settings.videoDeviceId),
              ),
        }
      : { ...settings, audioDeviceId: deviceId };
    setSettings(next);
    void persistSettings(next);
  };
  const handlePreviewStage = useCallback((element: HTMLDivElement | null) => {
    captureBridge.attachStage(element);
  }, []);
  const handlePreviewMutedChange = (previewMuted: boolean) => {
    const next = { ...settings, previewMuted };
    setSettings(next);
    void captureBridge.setPreviewAudio(previewMuted, next.previewVolume ?? 0.7)
      .catch((cause) => setPreviewError(String(cause)));
    void persistSettings(next);
  };
  const handlePreviewVolumeChange = (previewVolume: number) => {
    updateSettings("previewVolume", previewVolume);
    void captureBridge.setPreviewAudio(settings.previewMuted ?? true, previewVolume)
      .catch((cause) => setPreviewError(String(cause)));
  };
  const handlePreviewVolumeCommit = (previewVolume: number) => {
    const next = { ...settings, previewVolume };
    setSettings(next);
    void persistSettings(next);
  };
  const handleMonitoringStart = async () => {
    setError(null);
    setMonitoringOperation("starting");
    try {
      await persistSettings();
      setMonitoring(await captureBridge.startMonitoring(settings));
    } catch (cause) {
      setError(`${t("monitoringStartFailed")} ${String(cause)}`);
      setPreviewRefresh((value) => value + 1);
    } finally {
      setMonitoringOperation(null);
    }
  };
  const handleMonitoringStop = async () => {
    setError(null);
    setMonitoringOperation("stopping");
    try {
      setMonitoring(await captureBridge.stopMonitoring());
      setRuntime(await getRecordingStatus());
    } catch (cause) {
      setError(`${t("monitoringStopFailed")} ${String(cause)}`);
    } finally {
      setMonitoringOperation(null);
    }
  };
  const handleOpenOutputFolder = async () => {
    if (!settings.outputDirectory) return;
    setError(null);
    try {
      await openOutputDirectory();
    } catch (cause) {
      setError(`${t("openOutputFolderFailed")} ${String(cause)}`);
    }
  };
  const effectiveRecordingMode = monitoring.running
    ? "automatic"
    : isRecording
      ? "manual"
      : settings.recordingMode;
  const actionBusy = effectiveRecordingMode === "automatic" ? monitoringBusy : manualBusy;
  const automaticPreparing = effectiveRecordingMode === "automatic"
    && monitoringOperation === "starting";
  const displayedFile = isFinalizing && runtime.currentFile
    ? { label: t("fileWriting"), path: runtime.currentFile }
    : !isRecording && runtime.nextFile
      ? { label: t("nextFile"), path: runtime.nextFile }
      : runtime.currentFile
        ? { label: t("currentFile"), path: runtime.currentFile }
        : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <BrandMark />
          <h1>TapeCapture</h1>
        </div>
        <SettingsMenu
          language={settings.language}
          theme={settings.theme}
          t={t}
          onLanguageChange={(language) => updateAndPersistSettings("language", language)}
          onThemeChange={(theme) => updateAndPersistSettings("theme", theme)}
          onError={(cause) => setError(String(cause))}
        />
        <BuildInfo />
      </header>

      {isTauri && ffmpeg && !ffmpeg.available && (
        <FfmpegRequirementNotice
          checking={ffmpegChecking}
          t={t}
          onDownload={() => void handleOpenFfmpegDownload()}
          onRecheck={() => void refreshFfmpeg()}
        />
      )}

      <main className="workspace">
        <aside className="setup-column">
          <CaptureSetupPanel
            settings={settings}
            videoDevices={videoDevices}
            audioDevices={audioDevices}
            effectiveAudioDeviceId={effectiveAudioDeviceId}
            videoModes={videoModes}
            selectedVideoMode={selectedVideoMode}
            loadingVideoModes={loadingVideoModes}
            loadingDevices={loadingDevices}
            locked={settingsLocked}
            t={t}
            onRefresh={() => void refreshDevices().then(() => {
              previewFailureRef.current = { key: "", count: 0 };
              setPreviewRefresh((value) => value + 1);
            })}
            onVideoDeviceChange={handleVideoDeviceChange}
            onVideoModeChange={handleVideoModeChange}
            onAudioModeChange={handleAudioModeChange}
            onAudioDeviceChange={handleAudioDeviceChange}
            onChooseOutputDirectory={() => void chooseOutputDirectory()}
            onOutputContainerChange={(container) => updateAndPersistSettings("outputContainer", container)}
            onQualityPresetChange={(preset) => updateAndPersistSettings("qualityPreset", preset)}
          />

        </aside>

        <section className="main-column">
          <PreviewPanel
            running={previewLive}
            recording={isRecording}
            audioAvailable={previewAudioAvailable}
            muted={settings.previewMuted ?? true}
            volume={settings.previewVolume ?? 0.7}
            t={t}
            onStageElement={handlePreviewStage}
            onMutedChange={handlePreviewMutedChange}
            onVolumeChange={handlePreviewVolumeChange}
            onVolumeCommit={handlePreviewVolumeCommit}
          />
          {previewError && <div className="inline-alert" role="alert">{previewError}</div>}
          <CaptureControls
            runtime={runtime}
            monitoring={monitoring}
            recordingMode={effectiveRecordingMode}
            freeSpaceBytes={freeSpaceBytes}
            videoFormat={previewVideoFormat}
            displayedFile={displayedFile}
            canRecord={canRecord}
            actionBusy={actionBusy}
            automaticPreparing={automaticPreparing}
            isRecording={isRecording}
            isFinalizing={isFinalizing}
            recordingSettingsDisabled={settingsLocked || recordingSettingsOpen || !isTauri}
            t={t}
            onRecordingModeChange={(recordingMode) => updateAndPersistSettings("recordingMode", recordingMode)}
            onPrimaryAction={() => void (
              effectiveRecordingMode === "automatic"
                ? monitoring.running
                  ? handleMonitoringStop()
                  : handleMonitoringStart()
                : isRecording
                  ? handleStop()
                  : handleManualStart()
            )}
            onOpenRecordingSettings={() => void handleOpenRecordingSettings()}
            onOpenOutputFolder={() => void handleOpenOutputFolder()}
          />
        </section>
      </main>

      {error && <div className="toast toast--error" role="alert">{error}</div>}
    </div>
  );
}

export default App;
