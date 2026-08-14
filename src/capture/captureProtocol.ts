import type {
  AppSettings,
  CaptureDevice,
  CaptureVideoMode,
  MonitoringSnapshot,
  RecordingSnapshot,
} from "../models";

export const CAPTURE_WEBVIEW_LABEL = "capture-host";
export const CAPTURE_COMMAND_EVENT = "tapecapture-command";
export const CAPTURE_RESPONSE_EVENT = "tapecapture-response";

export interface CaptureVideoFormat {
  width: number | null;
  height: number | null;
  frameRate: number | null;
}

export interface CapturePreviewStatus extends CaptureVideoFormat {
  videoDeviceId: string | null;
  running: boolean;
  audioAvailable: boolean;
}

export interface CaptureOpenResult extends CapturePreviewStatus {
  supportedVideoModes: CaptureVideoMode[];
  selectedVideoMode: CaptureVideoMode | null;
}

export type CaptureCommand =
  | { id: string; action: "listDevices" }
  | {
      id: string;
      action: "open";
      videoDeviceId: string;
      audioDeviceId: string | null;
      videoMode: CaptureVideoMode | null;
    }
  | { id: string; action: "previewStatus" }
  | { id: string; action: "closeStream" }
  | { id: string; action: "previewAudio"; muted: boolean; volume: number }
  | { id: string; action: "startManual"; settings: AppSettings }
  | { id: string; action: "stopRecording" }
  | { id: string; action: "startMonitoring"; settings: AppSettings }
  | { id: string; action: "stopMonitoring" };

export type CaptureCommandInput = CaptureCommand extends infer Command
  ? Command extends { id: string }
    ? Omit<Command, "id">
    : never
  : never;

export type CaptureCommandResult =
  | CaptureDevice[]
  | CaptureOpenResult
  | CapturePreviewStatus
  | RecordingSnapshot
  | MonitoringSnapshot
  | null;

export interface CaptureResponse {
  id: string;
  ok: boolean;
  result?: CaptureCommandResult;
  error?: string;
}
