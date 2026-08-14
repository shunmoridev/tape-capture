export type ThemePreference = "system" | "light" | "dark";
export type Language = "ja" | "en";
export type OutputContainer = "mkv" | "mp4";
export type QualityPreset = "archival" | "balanced" | "compact";
export type RecordingMode = "automatic" | "manual";
export type AudioSourceMode = "auto" | "manual" | "none";

export type DeviceKind = "video" | "audio";

export interface CaptureDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  alternativeName?: string;
  suggestedAudioDeviceId?: string | null;
}

export interface CaptureVideoMode {
  width: number;
  height: number;
  frameRate: number;
}

export interface FfmpegStatus {
  available: boolean;
  version?: string;
  source?: string;
  error?: string;
}

export interface AppSettings {
  videoDeviceId: string | null;
  audioDeviceId: string | null;
  audioSourceMode: AudioSourceMode;
  audioDeviceMappings: Record<string, string>;
  videoModeMappings: Record<string, CaptureVideoMode>;
  outputDirectory: string;
  outputContainer: OutputContainer;
  qualityPreset: QualityPreset;
  recordingMode: RecordingMode;
  theme: ThemePreference;
  language: Language;
  startConfirmationMs: number;
  stopConfirmationMs: number;
  analysisIntervalMs: number;
  preRollMs: number;
  previewMuted: boolean;
  previewVolume: number;
}

export type RecordingState =
  | "idle"
  | "monitoring"
  | "startConfirming"
  | "recording"
  | "stopConfirming"
  | "finalizing"
  | "error";

export interface RecordingSnapshot {
  state: RecordingState;
  elapsedMs: number;
  currentFile: string | null;
  nextFile: string | null;
  currentFileSize: number;
  lastError: string | null;
  pendingFinalizations: number;
  finalizationActive: boolean;
  filesCompleted: number;
  finalizationFailures: number;
  lastFinalizationError: string | null;
  recoverableFile: string | null;
}

export interface MonitoringSnapshot {
  running: boolean;
  state: RecordingState;
  confirmationElapsedMs: number;
  confirmationTargetMs: number;
  lastError: string | null;
}

export interface BeginRecordingResponse {
  sessionId: string;
  snapshot: RecordingSnapshot;
}

export type CaptureAction = "none" | "startRecording" | "stopRecording";

export interface MonitoringDecision {
  action: CaptureAction;
  snapshot: MonitoringSnapshot;
}

export interface FrameFeatures {
  averageLuma: number;
  lumaVariance: number;
  colorVariance: number;
  dominantColorRatio: number;
  frameDifference: number;
  edgeEnergy: number;
  informationEntropy: number;
  audioRmsDb: number | null;
  inactiveCandidate: boolean;
}

export const EMPTY_MONITORING: MonitoringSnapshot = {
  running: false,
  state: "idle",
  confirmationElapsedMs: 0,
  confirmationTargetMs: 0,
  lastError: null,
};

export const DEFAULT_SETTINGS: AppSettings = {
  videoDeviceId: null,
  audioDeviceId: null,
  audioSourceMode: "auto",
  audioDeviceMappings: {},
  videoModeMappings: {},
  outputDirectory: "",
  outputContainer: "mkv",
  qualityPreset: "balanced",
  recordingMode: "automatic",
  theme: "system",
  language: "ja",
  startConfirmationMs: 1500,
  stopConfirmationMs: 10000,
  analysisIntervalMs: 300,
  preRollMs: 5000,
  previewMuted: true,
  previewVolume: 0.7,
};
