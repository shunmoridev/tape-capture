import {
  analyzeCaptureFrame,
  appendRecordingChunk,
  beginRecording,
  clearRecordingEndBoundary,
  finishRecording,
  getRecordingStatus,
  monitoringFailed,
  monitoringManualStart,
  monitoringManualStop,
  monitoringRecordingFinalized,
  monitoringRecordingStarted,
  markRecordingEndBoundary,
  observeMonitoring,
  resetCaptureAnalysis,
  sealRecording,
  startMonitoringState,
  stopMonitoringState,
} from "../api";
import type {
  AppSettings,
  CaptureDevice,
  CaptureVideoMode,
  MonitoringSnapshot,
  RecordingSnapshot,
} from "../models";
import type { CaptureOpenResult, CapturePreviewStatus } from "./captureProtocol";

const CHUNK_INTERVAL_MS = 1_000;
const ANALYSIS_WIDTH = 160;
const ANALYSIS_HEIGHT = 120;
const ANALYSIS_READY_TIMEOUT_MS = 10_000;
const ANALYSIS_READY_RETRY_MS = 50;
const MAX_PENDING_CHUNK_BYTES = 32 * 1024 * 1024;
const RESUME_PENDING_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_PRE_ROLL_BYTES = 64 * 1024 * 1024;
const PREFERRED_CAPTURE_WIDTH = 3_840;
const PREFERRED_CAPTURE_HEIGHT = 2_160;
const PREFERRED_CAPTURE_FRAME_RATE = 30;
const VIDEO_MODE_PROBES = [
  { width: 3_840, height: 2_160 },
  { width: 2_560, height: 1_440 },
  { width: 1_920, height: 1_080 },
  { width: 1_280, height: 960 },
  { width: 1_280, height: 720 },
  { width: 1_024, height: 768 },
  { width: 720, height: 576 },
  { width: 720, height: 480 },
  { width: 640, height: 480 },
  { width: 480, height: 480 },
  { width: 352, height: 240 },
  { width: 320, height: 240 },
] as const;

type RecorderMode = "idle" | "rolling" | "transitioning" | "saving" | "stopping";

export interface BufferedChunk {
  bytes: Uint8Array;
  capturedAt: number;
}

export async function listMediaDevices(): Promise<CaptureDevice[]> {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.enumerateDevices || !mediaDevices.getUserMedia) {
    throw new Error("This system WebView does not provide media capture APIs.");
  }
  let devices = await mediaDevices.enumerateDevices();
  if (!devices.some((device) => device.label)) {
    let permissionStream: MediaStream | null = null;
    try {
      permissionStream = await mediaDevices.getUserMedia({ video: true, audio: true });
    } catch {
      permissionStream = await mediaDevices.getUserMedia({ video: true, audio: false });
    } finally {
      permissionStream?.getTracks().forEach((track) => track.stop());
    }
    devices = await mediaDevices.enumerateDevices();
  }

  const audio = devices.filter((device) => device.kind === "audioinput");
  let videoIndex = 0;
  let audioIndex = 0;
  return devices
    .filter((device) => device.kind === "videoinput" || device.kind === "audioinput")
    .map((device): CaptureDevice => {
      const isVideo = device.kind === "videoinput";
      const ordinal = isVideo ? ++videoIndex : ++audioIndex;
      const suggestedAudio = isVideo ? suggestAudioDevice(device, audio)?.deviceId ?? null : null;
      return {
        id: device.deviceId,
        name: device.label || `${isVideo ? "Video input" : "Audio input"} ${ordinal}`,
        kind: isVideo ? "video" : "audio",
        suggestedAudioDeviceId: suggestedAudio,
      };
  });
}

export function suggestAudioDevice(
  video: MediaDeviceInfo,
  audioDevices: MediaDeviceInfo[],
): MediaDeviceInfo | null {
  if (video.groupId) {
    const grouped = audioDevices.find(
      (candidate) => candidate.groupId && candidate.groupId === video.groupId,
    );
    if (grouped) return grouped;
  }

  const concreteAudio = audioDevices.filter(
    (candidate) => candidate.deviceId !== "default" && candidate.deviceId !== "communications",
  );
  const candidates = concreteAudio.length ? concreteAudio : audioDevices;
  if (candidates.length === 1) return candidates[0];

  const videoTokens = meaningfulDeviceTokens(video.label);
  let best: { device: MediaDeviceInfo; score: number } | null = null;
  for (const candidate of candidates) {
    const audioTokens = meaningfulDeviceTokens(candidate.label);
    const sharedTokens = [...videoTokens].filter((token) => audioTokens.has(token)).length;
    const normalizedVideo = normalizeDeviceLabel(video.label);
    const normalizedAudio = normalizeDeviceLabel(candidate.label);
    const containedName = normalizedVideo.length >= 5
      && (normalizedAudio.includes(normalizedVideo) || normalizedVideo.includes(normalizedAudio));
    const score = sharedTokens * 2 + (containedName ? 3 : 0);
    if (!best || score > best.score) best = { device: candidate, score };
  }
  return best && best.score >= 2 ? best.device : null;
}

const GENERIC_DEVICE_TOKENS = new Set([
  "audio", "video", "input", "output", "device", "interface", "capture",
  "camera", "microphone", "digital", "source", "default", "communications",
]);

function meaningfulDeviceTokens(label: string): Set<string> {
  return new Set(
    normalizeDeviceLabel(label)
      .split(" ")
      .filter((token) => token.length >= 3 && !GENERIC_DEVICE_TOKENS.has(token)),
  );
}

function normalizeDeviceLabel(label: string): string {
  return label
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

async function openCaptureStream(
  videoDeviceId: string,
  audioDeviceId: string | null,
  requestedMode: CaptureVideoMode | null,
): Promise<MediaStream> {
  const supportedConstraints = navigator.mediaDevices.getSupportedConstraints?.() ?? {};
  const audio: MediaTrackConstraints | false = audioDeviceId
    ? captureAudioConstraints(audioDeviceId, supportedConstraints)
    : false;
  const commonVideoConstraints: MediaTrackConstraints = {
    deviceId: { exact: videoDeviceId },
    frameRate: { ideal: PREFERRED_CAPTURE_FRAME_RATE },
    resizeMode: { ideal: "none" },
  };
  const preferredWidth = requestedMode?.width ?? PREFERRED_CAPTURE_WIDTH;
  const preferredHeight = requestedMode?.height ?? PREFERRED_CAPTURE_HEIGHT;
  const preferredFrameRate = requestedMode?.frameRate ?? PREFERRED_CAPTURE_FRAME_RATE;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...commonVideoConstraints,
        width: { exact: preferredWidth },
        height: { exact: preferredHeight },
        frameRate: { ideal: preferredFrameRate },
      },
      audio,
    });
  } catch (error) {
    if (!isUnsupportedCaptureMode(error)) throw error;
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...commonVideoConstraints,
        width: { ideal: preferredWidth },
        height: { ideal: preferredHeight },
        frameRate: { ideal: preferredFrameRate },
      },
      audio,
    });
  }

  await configureCaptureAudioTracks(stream, supportedConstraints);
  return stream;
}

export function captureAudioConstraints(
  audioDeviceId: string,
  supported: MediaTrackSupportedConstraints,
): MediaTrackConstraints {
  return {
    deviceId: { exact: audioDeviceId },
    ...(supported.echoCancellation ? { echoCancellation: false } : {}),
    ...(supported.noiseSuppression ? { noiseSuppression: false } : {}),
    ...(supported.autoGainControl ? { autoGainControl: false } : {}),
    ...(supported.sampleRate ? { sampleRate: { ideal: 48_000 } } : {}),
    ...(supported.sampleSize ? { sampleSize: { ideal: 16 } } : {}),
    ...(supported.channelCount ? { channelCount: { ideal: 2 } } : {}),
  };
}

async function configureCaptureAudioTracks(
  stream: MediaStream,
  supported: MediaTrackSupportedConstraints,
): Promise<void> {
  await Promise.all(stream.getAudioTracks().map(async (track) => {
    if ("contentHint" in track) track.contentHint = "music";

    let capabilities: MediaTrackCapabilities | null = null;
    try {
      capabilities = track.getCapabilities();
    } catch {
      // Initial getUserMedia constraints remain in effect.
    }

    const processingConstraints: MediaTrackConstraints = {};
    if (supported.echoCancellation) {
      processingConstraints.echoCancellation = disableAudioProcessingConstraint(
        capabilities?.echoCancellation,
      );
    }
    if (supported.noiseSuppression) {
      processingConstraints.noiseSuppression = disableAudioProcessingConstraint(
        capabilities?.noiseSuppression,
      );
    }
    if (supported.autoGainControl) {
      processingConstraints.autoGainControl = disableAudioProcessingConstraint(
        capabilities?.autoGainControl,
      );
    }

    if (!Object.keys(processingConstraints).length) return;
    try {
      await track.applyConstraints(processingConstraints);
    } catch {
      // A capture driver may advertise a constraint globally without allowing
      // it on this device. Keep the usable stream rather than rejecting input.
    }
  }));
}

function disableAudioProcessingConstraint(
  capability: boolean[] | undefined,
): ConstrainBoolean {
  return capability?.includes(false) ? { exact: false } : false;
}

function isUnsupportedCaptureMode(error: unknown): boolean {
  return error instanceof DOMException
    && (error.name === "OverconstrainedError" || error.name === "ConstraintNotSatisfiedError");
}

function advertisedVideoModes(track: MediaStreamTrack): CaptureVideoMode[] {
  const discovered = new Map<string, CaptureVideoMode>();
  const initialMode = videoModeFromTrack(track);
  if (initialMode) discovered.set(videoModeKey(initialMode), initialMode);

  let capabilities: MediaTrackCapabilities | null = null;
  try {
    capabilities = track.getCapabilities();
  } catch {
    // Exact constraint probes below still work when capabilities are unavailable.
  }
  const maximumFrameRate = Math.min(
    60,
    largestPositiveNumber(capabilities?.frameRate?.max, initialMode?.frameRate) ?? 30,
  );
  const minimumFrameRate = positiveNumber(capabilities?.frameRate?.min) ?? 1;

  for (const dimensions of VIDEO_MODE_PROBES) {
    if (!dimensionsWithinCapabilities(dimensions, capabilities)) continue;
    const frameRates = videoModeProbeFrameRates(
      dimensions.width,
      dimensions.height,
      maximumFrameRate,
    );
    for (const frameRate of frameRates) {
      if (frameRate < minimumFrameRate || frameRate > maximumFrameRate + 0.25) continue;
      const candidate = {
        width: dimensions.width,
        height: dimensions.height,
        frameRate,
      };
      discovered.set(videoModeKey(candidate), candidate);
    }
  }

  return [...discovered.values()].sort(compareVideoModes);
}

function dimensionsWithinCapabilities(
  dimensions: { width: number; height: number },
  capabilities: MediaTrackCapabilities | null,
): boolean {
  const minimumWidth = positiveNumber(capabilities?.width?.min);
  const maximumWidth = positiveNumber(capabilities?.width?.max);
  const minimumHeight = positiveNumber(capabilities?.height?.min);
  const maximumHeight = positiveNumber(capabilities?.height?.max);
  return (!minimumWidth || dimensions.width >= minimumWidth)
    && (!maximumWidth || dimensions.width <= maximumWidth)
    && (!minimumHeight || dimensions.height >= minimumHeight)
    && (!maximumHeight || dimensions.height <= maximumHeight);
}

export function videoModeProbeFrameRates(
  width: number,
  height: number,
  maximumFrameRate: number,
): number[] {
  const candidates = width === 720 && height === 480
    ? [29.97, 30, maximumFrameRate]
    : width === 720 && height === 576
      ? [25, 50, maximumFrameRate]
      : [maximumFrameRate, 30];
  return [...new Set(candidates.filter((value) => value > 0))];
}

async function applyVideoMode(
  track: MediaStreamTrack,
  mode: CaptureVideoMode,
): Promise<CaptureVideoMode | null> {
  const constraints: MediaTrackConstraints = {
    width: { exact: mode.width },
    height: { exact: mode.height },
    frameRate: {
      ideal: mode.frameRate,
      min: Math.max(1, mode.frameRate - 0.25),
      max: mode.frameRate + 0.25,
    },
  };

  let nativeResizeMode = false;
  try {
    nativeResizeMode = track.getCapabilities().resizeMode?.includes("none") ?? false;
  } catch {
    // Continue with the constraints supported by this WebView.
  }
  if (nativeResizeMode) constraints.resizeMode = { exact: "none" };

  try {
    await track.applyConstraints(constraints);
  } catch {
    return null;
  }

  const applied = videoModeFromTrack(track);
  return applied && applied.width === mode.width && applied.height === mode.height
    ? applied
    : null;
}

function videoModeFromTrack(track: MediaStreamTrack): CaptureVideoMode | null {
  const settings = track.getSettings();
  const width = positiveNumber(settings.width);
  const height = positiveNumber(settings.height);
  const frameRate = positiveNumber(settings.frameRate);
  return width && height && frameRate ? { width, height, frameRate } : null;
}

function selectDefaultVideoMode(modes: CaptureVideoMode[]): CaptureVideoMode | null {
  const ntscModes = modes
    .filter((mode) => mode.width === 720 && mode.height === 480)
    .sort((left, right) => (
      Math.abs(left.frameRate - 29.97) - Math.abs(right.frameRate - 29.97)
    ));
  return ntscModes[0] ?? modes[0] ?? null;
}

function findSupportedVideoMode(
  modes: CaptureVideoMode[],
  requested: CaptureVideoMode | null,
): CaptureVideoMode | null {
  if (!requested) return null;
  return modes.find((mode) => sameVideoMode(mode, requested)) ?? null;
}

function sameVideoMode(left: CaptureVideoMode | null, right: CaptureVideoMode | null): boolean {
  return Boolean(
    left
    && right
    && left.width === right.width
    && left.height === right.height
    && Math.abs(left.frameRate - right.frameRate) < 0.3,
  );
}

function videoModeKey(mode: CaptureVideoMode): string {
  return `${mode.width}x${mode.height}@${mode.frameRate.toFixed(2)}`;
}

function compareVideoModes(left: CaptureVideoMode, right: CaptureVideoMode): number {
  const pixelDifference = right.width * right.height - left.width * left.height;
  return pixelDifference || right.frameRate - left.frameRate;
}

export class MediaCaptureEngine {
  private stream: MediaStream | null = null;
  private streamKey = "";
  private videoDeviceId: string | null = null;
  private supportedVideoModes: CaptureVideoMode[] = [];
  private selectedVideoMode: CaptureVideoMode | null = null;
  private videoModeCache = new Map<string, CaptureVideoMode[]>();
  private previewElement: HTMLVideoElement | null = null;
  private recorder: MediaRecorder | null = null;
  private recorderMode: RecorderMode = "idle";
  private recorderStop: Promise<void> | null = null;
  private recorderStopRequested = false;
  private dataBoundaryWaiters: Array<() => void> = [];
  private sessionId: string | null = null;
  private settings: AppSettings | null = null;
  private initBytes: Uint8Array | null = null;
  private preRoll: BufferedChunk[] = [];
  private preRollBytes = 0;
  private activeCandidateSince: number | null = null;
  private automaticEndBoundaryMarked = false;
  private chunkQueue: Promise<void> = Promise.resolve();
  private pendingChunkBytes = 0;
  private recorderPausedForBackpressure = false;
  private analysisTimer: number | null = null;
  private analysisBusy = false;
  private transitionBusy = false;
  private transitionTail: Promise<void> = Promise.resolve();
  private failureRecovery: Promise<void> | null = null;
  private finalizations = new Set<Promise<RecordingSnapshot>>();
  private monitoring = false;
  private canvas: HTMLCanvasElement | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private audioSamples: Float32Array<ArrayBuffer> | null = null;

  async open(
    videoDeviceId: string,
    audioDeviceId: string | null,
    requestedMode: CaptureVideoMode | null,
  ): Promise<MediaStream> {
    const key = `${videoDeviceId}\n${audioDeviceId ?? ""}`;
    if (this.stream && this.streamKey === key && this.stream.active) {
      if (!requestedMode || sameVideoMode(requestedMode, this.selectedVideoMode)) {
        return this.stream;
      }
      const currentTrack = this.stream.getVideoTracks()[0];
      const supportedMode = findSupportedVideoMode(this.supportedVideoModes, requestedMode);
      if (currentTrack && supportedMode) {
        const applied = await applyVideoMode(currentTrack, supportedMode);
        if (applied) {
          this.selectedVideoMode = applied;
          return this.stream;
        }
        this.supportedVideoModes = this.supportedVideoModes
          .filter((mode) => !sameVideoMode(mode, supportedMode));
        this.videoModeCache.set(videoDeviceId, this.supportedVideoModes);
      }
      return this.stream;
    }
    if (this.monitoring || this.sessionId) {
      throw new Error("Stop monitoring or recording before changing the input device.");
    }
    this.closeStream();
    const stream = await openCaptureStream(videoDeviceId, audioDeviceId, requestedMode);
    const videoTrack = stream.getVideoTracks()[0];
    let supportedModes = this.videoModeCache.get(videoDeviceId) ?? null;
    if (videoTrack && !supportedModes) {
      supportedModes = advertisedVideoModes(videoTrack);
      this.videoModeCache.set(videoDeviceId, supportedModes);
    }
    supportedModes ??= [];
    const requestedSupportedMode = findSupportedVideoMode(supportedModes, requestedMode);
    const defaultMode = selectDefaultVideoMode(supportedModes);
    const initialMode = videoTrack ? videoModeFromTrack(videoTrack) : null;
    let appliedMode: CaptureVideoMode | null = null;
    const modesToTry = [requestedSupportedMode, defaultMode]
      .filter((mode): mode is CaptureVideoMode => Boolean(mode))
      .filter((mode, index, modes) => (
        modes.findIndex((candidate) => sameVideoMode(candidate, mode)) === index
      ));
    for (const mode of modesToTry) {
      if (initialMode && sameVideoMode(mode, initialMode)) {
        appliedMode = initialMode;
        break;
      }
      if (!videoTrack) break;
      appliedMode = await applyVideoMode(videoTrack, mode);
      if (appliedMode) break;
      supportedModes = supportedModes.filter((candidate) => !sameVideoMode(candidate, mode));
      this.videoModeCache.set(videoDeviceId, supportedModes);
    }
    appliedMode ??= videoTrack ? videoModeFromTrack(videoTrack) : null;
    if (appliedMode && !supportedModes.some((mode) => sameVideoMode(mode, appliedMode))) {
      supportedModes = [...supportedModes, appliedMode].sort(compareVideoModes);
      this.videoModeCache.set(videoDeviceId, supportedModes);
    }
    this.stream = stream;
    this.streamKey = key;
    this.videoDeviceId = videoDeviceId;
    this.supportedVideoModes = supportedModes;
    this.selectedVideoMode = appliedMode;
    videoTrack?.addEventListener("ended", () => {
      if (this.stream === stream && (this.monitoring || this.sessionId)) {
        void this.handleCaptureFailure("The video input was disconnected.");
      }
    });
    if (this.previewElement) {
      this.previewElement.srcObject = stream;
      await this.previewElement.play();
    }
    this.configureAudioMeter(stream);
    return stream;
  }

  attachPreview(element: HTMLVideoElement | null): void {
    this.previewElement = element;
    if (!element) return;
    element.srcObject = this.stream;
    if (this.stream) void element.play();
  }

  get currentStream(): MediaStream | null {
    return this.stream;
  }

  getPreviewStatus(): CapturePreviewStatus {
    const stream = this.stream;
    const videoTrack = stream?.getVideoTracks()[0];
    const trackSettings = videoTrack?.getSettings();
    const preview = this.previewElement;
    return {
      videoDeviceId: this.videoDeviceId,
      running: Boolean(stream?.active && videoTrack?.readyState === "live"),
      audioAvailable: Boolean(
        stream?.getAudioTracks().some((track) => track.readyState === "live"),
      ),
      width: positiveNumber(trackSettings?.width)
        ?? positiveNumber(preview?.videoWidth),
      height: positiveNumber(trackSettings?.height)
        ?? positiveNumber(preview?.videoHeight),
      frameRate: positiveNumber(trackSettings?.frameRate),
    };
  }

  getOpenResult(): CaptureOpenResult {
    return {
      ...this.getPreviewStatus(),
      supportedVideoModes: this.supportedVideoModes,
      selectedVideoMode: this.selectedVideoMode,
    };
  }

  closeStream(): void {
    if (this.monitoring || this.sessionId) return;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.streamKey = "";
    this.videoDeviceId = null;
    this.supportedVideoModes = [];
    this.selectedVideoMode = null;
    if (this.previewElement) this.previewElement.srcObject = null;
    void this.audioContext?.close();
    this.audioContext = null;
    this.analyser = null;
    this.audioSamples = null;
  }

  async startManual(settings: AppSettings): Promise<RecordingSnapshot> {
    this.requireStream();
    if (this.monitoring) {
      const decision = await monitoringManualStart();
      if (decision.action === "startRecording") await this.beginSavingFromPreRoll(null);
      return getRecordingStatus();
    }
    if (this.sessionId) return getRecordingStatus();
    this.settings = settings;
    const recorder = this.createRecorder();
    const response = await beginRecording(settings, recorder.mimeType);
    this.sessionId = response.sessionId;
    this.recorderMode = "saving";
    this.installRecorder(recorder);
    recorder.start(CHUNK_INTERVAL_MS);
    return response.snapshot;
  }

  async stopRecording(): Promise<RecordingSnapshot> {
    if (this.monitoring) {
      const decision = await monitoringManualStop();
      if (decision.action === "stopRecording") {
        await this.clearAutomaticEndBoundary();
        return this.finishSaving(true);
      }
      return getRecordingStatus();
    }
    return this.finishSaving(false);
  }

  async startMonitoring(settings: AppSettings): Promise<MonitoringSnapshot> {
    this.requireStream();
    if (this.monitoring) return startMonitoringState(settings);
    this.settings = settings;
    this.activeCandidateSince = null;
    this.automaticEndBoundaryMarked = false;
    await startMonitoringState(settings);
    this.monitoring = true;
    try {
      await this.audioContext?.resume();
      await resetCaptureAnalysis();
      this.startRollingRecorder();
      const readySnapshot = await this.waitForFirstAnalysis();
      this.scheduleAnalysis();
      return readySnapshot;
    } catch (cause) {
      this.monitoring = false;
      if (this.analysisTimer !== null) window.clearTimeout(this.analysisTimer);
      this.analysisTimer = null;
      await this.stopRecorderOnly().catch(() => undefined);
      this.settings = null;
      this.preRoll = [];
      this.preRollBytes = 0;
      this.activeCandidateSince = null;
      this.automaticEndBoundaryMarked = false;
      this.initBytes = null;
      await resetCaptureAnalysis().catch(() => undefined);
      await stopMonitoringState().catch(() => undefined);
      throw cause;
    }
  }

  async stopMonitoring(): Promise<MonitoringSnapshot> {
    await this.clearAutomaticEndBoundary();
    this.monitoring = false;
    if (this.analysisTimer !== null) window.clearTimeout(this.analysisTimer);
    this.analysisTimer = null;
    await this.finishSaving(false);
    await this.runTransition(() => this.stopRecorderOnly());
    this.settings = null;
    this.preRoll = [];
    this.preRollBytes = 0;
    this.activeCandidateSince = null;
    this.automaticEndBoundaryMarked = false;
    this.initBytes = null;
    await resetCaptureAnalysis();
    return stopMonitoringState();
  }

  private requireStream(): MediaStream {
    if (!this.stream?.active) throw new Error("The selected capture stream is not available.");
    return this.stream;
  }

  private createRecorder(): MediaRecorder {
    const stream = this.requireStream();
    if (typeof MediaRecorder === "undefined") {
      throw new Error("This system WebView does not provide MediaRecorder.");
    }
    const mimeTypes = [
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
      // Chromium's fragmented MP4 MediaRecorder can fail when a long-running
      // recording reaches the classic 4 GiB container boundary. Keep MP4 as a
      // last-resort source format; Rust/FFmpeg still produces the user's chosen
      // MKV or MP4 output after capture.
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    ].filter((candidate) => MediaRecorder.isTypeSupported(candidate));
    const quality = this.settings?.qualityPreset ?? "balanced";
    const videoBitsPerSecond = quality === "archival"
      ? 16_000_000
      : quality === "compact"
        ? 5_000_000
        : 10_000_000;
    const bitrateOptions = { videoBitsPerSecond, audioBitsPerSecond: 192_000 };
    for (const mimeType of mimeTypes) {
      try {
        return new MediaRecorder(stream, { ...bitrateOptions, mimeType });
      } catch {
        // Some WebViews report a MIME type before the selected device exposes a
        // compatible track combination. Continue to the next portable format.
      }
    }
    return new MediaRecorder(stream, bitrateOptions);
  }

  private installRecorder(recorder: MediaRecorder): void {
    this.recorder = recorder;
    this.recorderStopRequested = false;
    this.recorderStop = new Promise((resolve) => {
      recorder.addEventListener("stop", () => {
        resolve();
        for (const release of this.dataBoundaryWaiters.splice(0)) release();
        if (
          !this.recorderStopRequested
          && this.recorder === recorder
          && (this.monitoring || this.sessionId)
        ) {
          void this.handleCaptureFailure("The capture recorder stopped unexpectedly.");
        }
      }, { once: true });
    });
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) {
        const deliveredMode = this.recorderMode;
        this.enqueueRecorderChunk(event.data, deliveredMode);
      }
      this.dataBoundaryWaiters.shift()?.();
    });
    recorder.addEventListener("error", (event) => {
      const detail = "error" in event ? String(event.error) : "MediaRecorder failed.";
      void this.handleCaptureFailure(detail);
    });
  }

  private startRollingRecorder(): void {
    if (!this.monitoring || this.recorder) return;
    this.recorderMode = "rolling";
    this.initBytes = null;
    this.preRoll = [];
    this.preRollBytes = 0;
    const recorder = this.createRecorder();
    this.installRecorder(recorder);
    recorder.start(CHUNK_INTERVAL_MS);
  }

  private async consumeChunk(blob: Blob, deliveredMode: RecorderMode): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (deliveredMode === "saving" || deliveredMode === "stopping") {
      await this.appendBytes(bytes);
      return;
    }
    if (deliveredMode !== "rolling" && deliveredMode !== "transitioning") return;
    let payload = bytes;
    if (!this.initBytes) {
      const split = splitContainerInitialization(bytes, this.recorder?.mimeType ?? blob.type);
      this.initBytes = split.initialization;
      payload = split.media;
    }
    if (payload.length) {
      this.preRoll.push({ bytes: payload, capturedAt: performance.now() });
      this.preRollBytes += payload.byteLength;
      this.prunePreRoll();
    }
  }

  private prunePreRoll(): void {
    const preRollMs = this.settings?.preRollMs ?? 5_000;
    if (preRollMs <= 0) {
      this.preRoll = [];
      this.preRollBytes = 0;
      return;
    }
    const cutoff = performance.now() - preRollMs - CHUNK_INTERVAL_MS;
    const pruned = pruneBufferedChunks(
      this.preRoll,
      this.preRollBytes,
      cutoff,
      MAX_PRE_ROLL_BYTES,
    );
    this.preRoll = pruned.chunks;
    this.preRollBytes = pruned.totalBytes;
  }

  private async beginSavingFromPreRoll(activeCandidateSince: number | null): Promise<void> {
    await this.runTransition(async () => {
      if (!this.monitoring || this.sessionId) return;
      const recorder = this.recorder;
      const settings = this.settings;
      if (!recorder || !settings) throw new Error("The monitoring recorder is unavailable.");
      this.recorderMode = "transitioning";
      await this.chunkQueue;
      const response = await beginRecording(settings, recorder.mimeType);
      this.sessionId = response.sessionId;
      this.recorderMode = "saving";
      this.chunkQueue = this.chunkQueue.catch(() => undefined).then(async () => {
        const initialization = this.initBytes;
        const buffered = selectStartBufferedChunks(
          this.preRoll.splice(0),
          activeCandidateSince,
          performance.now(),
          settings.preRollMs,
        );
        this.preRollBytes = 0;
        if (initialization?.length) await this.appendBytes(initialization);
        for (const chunk of buffered) await this.appendBytes(chunk.bytes);
      }).catch((cause) => {
        void this.handleCaptureFailure(cause);
      });
      recorder.requestData();
      await monitoringRecordingStarted();
    });
  }

  private async appendBytes(bytes: Uint8Array): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error("A recording chunk arrived without an active session.");
    await appendRecordingChunk(sessionId, bytes);
  }

  private async finishSaving(resumeMonitoring: boolean): Promise<RecordingSnapshot> {
    return this.runTransition(async () => {
      const sessionId = this.sessionId;
      if (!sessionId) return getRecordingStatus();
      this.recorderMode = "stopping";
      const keepRolling = resumeMonitoring && this.monitoring && Boolean(this.recorder);
      let rollingContinues = false;
      if (keepRolling) {
        await this.requestRecorderBoundary();
        if (this.monitoring) {
          this.recorderMode = "rolling";
          rollingContinues = true;
        } else {
          await this.stopRecorderOnly();
        }
      } else {
        await this.stopRecorderOnly();
      }
      await this.chunkQueue;
      const sealedSnapshot = await sealRecording(sessionId);
      this.sessionId = null;
      this.automaticEndBoundaryMarked = false;
      const finalization = this.trackFinalization(sessionId);
      if (rollingContinues && this.monitoring) {
        await monitoringRecordingFinalized();
        void finalization.catch(() => undefined);
        return sealedSnapshot;
      }
      this.recorderMode = "idle";
      this.initBytes = null;
      this.preRoll = [];
      this.preRollBytes = 0;
      void finalization.catch(() => undefined);
      return sealedSnapshot;
    });
  }

  private async requestRecorderBoundary(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") {
      throw new Error("The capture recorder is unavailable at the segment boundary.");
    }
    await new Promise<void>((resolve, reject) => {
      const release = () => resolve();
      this.dataBoundaryWaiters.push(release);
      try {
        recorder.requestData();
      } catch (cause) {
        const index = this.dataBoundaryWaiters.indexOf(release);
        if (index >= 0) this.dataBoundaryWaiters.splice(index, 1);
        reject(cause);
      }
    });
  }

  private async markAutomaticEndBoundary(): Promise<void> {
    await this.runTransition(async () => {
      const sessionId = this.sessionId;
      if (!sessionId || this.automaticEndBoundaryMarked) return;
      await this.requestRecorderBoundary();
      await this.chunkQueue;
      if (this.sessionId !== sessionId) return;
      await markRecordingEndBoundary(sessionId);
      this.automaticEndBoundaryMarked = true;
    });
  }

  private async clearAutomaticEndBoundary(): Promise<void> {
    await this.runTransition(async () => {
      const sessionId = this.sessionId;
      if (!sessionId || !this.automaticEndBoundaryMarked) {
        this.automaticEndBoundaryMarked = false;
        return;
      }
      await clearRecordingEndBoundary(sessionId);
      this.automaticEndBoundaryMarked = false;
    });
  }

  private async runTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.transitionTail;
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.transitionTail = previous.catch(() => undefined).then(() => turn);
    await previous.catch(() => undefined);
    this.transitionBusy = true;
    try {
      return await operation();
    } finally {
      this.transitionBusy = false;
      release();
    }
  }

  private trackFinalization(sessionId: string): Promise<RecordingSnapshot> {
    const finalization = finishRecording(sessionId);
    this.finalizations.add(finalization);
    void finalization.then(
      () => this.finalizations.delete(finalization),
      () => this.finalizations.delete(finalization),
    );
    return finalization;
  }

  private async stopRecorderOnly(): Promise<void> {
    const recorder = this.recorder;
    const stopped = this.recorderStop;
    if (recorder && recorder.state !== "inactive") {
      this.recorderStopRequested = true;
      recorder.stop();
    }
    if (stopped) await stopped;
    this.recorder = null;
    this.recorderStop = null;
    this.recorderStopRequested = false;
    if (!this.sessionId) this.recorderMode = "idle";
  }

  private scheduleAnalysis(delay = this.settings?.analysisIntervalMs ?? 300): void {
    if (!this.monitoring) return;
    if (this.analysisTimer !== null) window.clearTimeout(this.analysisTimer);
    this.analysisTimer = window.setTimeout(async () => {
      this.analysisTimer = null;
      await this.analyzeOnce();
      this.scheduleAnalysis();
    }, delay);
  }

  private async waitForFirstAnalysis(): Promise<MonitoringSnapshot> {
    const deadline = performance.now() + ANALYSIS_READY_TIMEOUT_MS;
    while (this.monitoring) {
      const snapshot = await this.analyzeOnce(true);
      if (snapshot) return snapshot;
      if (performance.now() >= deadline) {
        throw new Error("Timed out while waiting for the first capture analysis.");
      }
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, ANALYSIS_READY_RETRY_MS);
      });
    }
    throw new Error("Automatic monitoring stopped before capture analysis became ready.");
  }

  private async analyzeOnce(propagateFailure = false): Promise<MonitoringSnapshot | null> {
    if (!this.monitoring || this.analysisBusy || this.transitionBusy) return null;
    const video = this.previewElement;
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    this.analysisBusy = true;
    try {
      const canvas = this.canvas ?? document.createElement("canvas");
      this.canvas = canvas;
      canvas.width = ANALYSIS_WIDTH;
      canvas.height = ANALYSIS_HEIGHT;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Could not initialize the analysis canvas.");
      context.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
      const rgba = context.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data;
      const features = await analyzeCaptureFrame(
        new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        ANALYSIS_WIDTH,
        ANALYSIS_HEIGHT,
        this.readAudioRmsDb(),
      );
      const contentActive = !features.inactiveCandidate;
      const observedAt = performance.now();
      if (!this.sessionId) {
        if (contentActive) this.activeCandidateSince ??= observedAt;
        else this.activeCandidateSince = null;
      }
      const decision = await observeMonitoring(contentActive);
      if (decision.action === "startRecording") {
        await this.beginSavingFromPreRoll(this.activeCandidateSince);
        this.activeCandidateSince = null;
      }
      if (
        this.sessionId
        && decision.snapshot.state === "stopConfirming"
        && !this.automaticEndBoundaryMarked
      ) {
        await this.markAutomaticEndBoundary();
      }
      if (
        this.sessionId
        && contentActive
        && decision.snapshot.state === "recording"
        && this.automaticEndBoundaryMarked
      ) {
        await this.clearAutomaticEndBoundary();
      }
      if (decision.action === "stopRecording") await this.finishSaving(true);
      return decision.snapshot;
    } catch (cause) {
      await this.handleCaptureFailure(cause);
      if (propagateFailure) throw cause;
      return null;
    } finally {
      this.analysisBusy = false;
    }
  }

  private configureAudioMeter(stream: MediaStream): void {
    if (!stream.getAudioTracks().length) return;
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    this.audioContext = new AudioContextConstructor();
    const source = this.audioContext.createMediaStreamSource(stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
    this.audioSamples = new Float32Array(this.analyser.fftSize);
  }

  private readAudioRmsDb(): number | null {
    if (!this.analyser || !this.audioSamples) return null;
    this.analyser.getFloatTimeDomainData(this.audioSamples);
    let sum = 0;
    for (const sample of this.audioSamples) sum += sample * sample;
    const rms = Math.sqrt(sum / this.audioSamples.length);
    return 20 * Math.log10(Math.max(rms, 1e-8));
  }

  private async handleCaptureFailure(cause: unknown): Promise<void> {
    if (this.failureRecovery) return this.failureRecovery;
    const recovery = this.recoverFromCaptureFailure(cause);
    this.failureRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (this.failureRecovery === recovery) this.failureRecovery = null;
    }
  }

  private async recoverFromCaptureFailure(cause: unknown): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause);
    const wasMonitoring = this.monitoring;
    this.monitoring = false;
    this.transitionBusy = true;
    if (this.analysisTimer !== null) window.clearTimeout(this.analysisTimer);
    this.analysisTimer = null;
    this.recorderMode = "stopping";

    await this.clearAutomaticEndBoundary().catch(() => undefined);

    await this.stopRecorderOnly().catch(() => undefined);
    await this.chunkQueue.catch(() => undefined);

    const sessionId = this.sessionId;
    this.sessionId = null;
    if (sessionId) {
      const sealed = await sealRecording(sessionId).then(
        () => true,
        () => false,
      );
      if (sealed) void this.trackFinalization(sessionId).catch(() => undefined);
    }

    this.recorder = null;
    this.recorderStop = null;
    this.recorderMode = "idle";
    this.initBytes = null;
    this.preRoll = [];
    this.preRollBytes = 0;
    this.activeCandidateSince = null;
    this.automaticEndBoundaryMarked = false;
    this.pendingChunkBytes = 0;
    this.recorderPausedForBackpressure = false;
    this.settings = null;
    this.transitionBusy = false;
    await resetCaptureAnalysis().catch(() => undefined);
    if (wasMonitoring) {
      if (this.analysisTimer !== null) window.clearTimeout(this.analysisTimer);
      this.analysisTimer = null;
      await monitoringFailed(message).catch(() => undefined);
    }
  }

  private enqueueRecorderChunk(blob: Blob, deliveredMode: RecorderMode): void {
    this.pendingChunkBytes += blob.size;
    const recorder = this.recorder;
    if (
      this.pendingChunkBytes >= MAX_PENDING_CHUNK_BYTES
      && recorder?.state === "recording"
    ) {
      recorder.pause();
      this.recorderPausedForBackpressure = true;
    }

    this.chunkQueue = this.chunkQueue
      .catch(() => undefined)
      .then(() => this.consumeChunk(blob, deliveredMode))
      .catch((cause) => {
        void this.handleCaptureFailure(cause);
      })
      .finally(() => {
        this.pendingChunkBytes = Math.max(0, this.pendingChunkBytes - blob.size);
        const currentRecorder = this.recorder;
        if (
          this.recorderPausedForBackpressure
          && this.pendingChunkBytes <= RESUME_PENDING_CHUNK_BYTES
          && currentRecorder?.state === "paused"
        ) {
          currentRecorder.resume();
          this.recorderPausedForBackpressure = false;
        }
      });
  }

}

export function pruneBufferedChunks(
  chunks: BufferedChunk[],
  totalBytes: number,
  cutoff: number,
  maximumBytes: number,
): { chunks: BufferedChunk[]; totalBytes: number } {
  let firstRetained = 0;
  let retainedBytes = totalBytes;
  while (
    firstRetained < chunks.length
    && (
      chunks[firstRetained].capturedAt < cutoff
      || retainedBytes > maximumBytes
    )
  ) {
    retainedBytes = Math.max(
      0,
      retainedBytes - chunks[firstRetained].bytes.byteLength,
    );
    firstRetained += 1;
  }
  return {
    chunks: chunks.slice(firstRetained),
    totalBytes: retainedBytes,
  };
}

export function selectStartBufferedChunks(
  chunks: BufferedChunk[],
  activeCandidateSince: number | null,
  confirmedAt: number,
  preRollMs: number,
): BufferedChunk[] {
  // capturedAt is the end of an encoded chunk, so retaining the first chunk at
  // the cutoff already provides up to one chunk of safe overlap before it.
  const configuredCutoff = confirmedAt - Math.max(0, preRollMs);
  const activeCutoff = activeCandidateSince === null
    ? Number.NEGATIVE_INFINITY
    : activeCandidateSince;
  const cutoff = Math.max(configuredCutoff, activeCutoff);
  return chunks.filter((chunk) => chunk.capturedAt >= cutoff);
}

export function splitContainerInitialization(
  bytes: Uint8Array,
  mimeType: string,
): { initialization: Uint8Array; media: Uint8Array } {
  const marker = mimeType.includes("mp4")
    ? findAsciiBox(bytes, "moof")
    : findSequence(bytes, [0x1f, 0x43, 0xb6, 0x75]);
  if (marker <= 0) return { initialization: bytes, media: new Uint8Array() };
  const mediaStart = mimeType.includes("mp4") ? marker - 4 : marker;
  return {
    initialization: bytes.slice(0, mediaStart),
    media: bytes.slice(mediaStart),
  };
}

function findAsciiBox(bytes: Uint8Array, name: string): number {
  const marker = [...name].map((character) => character.charCodeAt(0));
  return findSequence(bytes, marker);
}

function findSequence(bytes: Uint8Array, marker: number[]): number {
  outer: for (let index = 0; index <= bytes.length - marker.length; index += 1) {
    for (let offset = 0; offset < marker.length; offset += 1) {
      if (bytes[index + offset] !== marker[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

export const mediaCapture = new MediaCaptureEngine();

function positiveNumber(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function largestPositiveNumber(...values: Array<number | undefined>): number | null {
  const candidates = values
    .map(positiveNumber)
    .filter((value): value is number => value !== null);
  return candidates.length ? Math.max(...candidates) : null;
}
