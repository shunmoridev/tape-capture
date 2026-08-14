import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AppSettings,
  CaptureDevice,
  CaptureVideoMode,
  MonitoringSnapshot,
  RecordingSnapshot,
} from "../models";
import {
  CAPTURE_COMMAND_EVENT,
  CAPTURE_RESPONSE_EVENT,
  CAPTURE_WEBVIEW_LABEL,
  type CaptureCommand,
  type CaptureCommandInput,
  type CaptureCommandResult,
  type CaptureOpenResult,
  type CapturePreviewStatus,
  type CaptureResponse,
} from "./captureProtocol";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const FINALIZATION_REQUEST_TIMEOUT_MS = 30 * 60_000;
const REQUEST_RETRY_MS = 300;
const REQUEST_RETRY_WINDOW_MS = 5_000;

interface PendingRequest {
  resolve: (value: CaptureCommandResult) => void;
  reject: (cause: Error) => void;
  timeout: number;
  retry: number;
  retryStop: number;
}

class CaptureBridge {
  private webview: Webview | null = null;
  private stage: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private responseUnlisten: UnlistenFn | null = null;
  private pending = new Map<string, PendingRequest>();
  private creating: Promise<Webview> | null = null;

  constructor() {
    window.addEventListener("resize", () => void this.syncBounds());
    window.addEventListener("scroll", () => void this.syncBounds(), true);
  }

  attachStage(element: HTMLElement | null): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.stage = element;
    if (!element) return;
    if (!("__TAURI_INTERNALS__" in window)) return;
    this.resizeObserver = new ResizeObserver(() => void this.syncBounds());
    this.resizeObserver.observe(element);
    void this.ensureHost().then(() => this.syncBounds());
  }

  async listMediaDevices(): Promise<CaptureDevice[]> {
    return this.request<CaptureDevice[]>({ action: "listDevices" });
  }

  async open(
    videoDeviceId: string,
    audioDeviceId: string | null,
    videoMode: CaptureVideoMode | null,
  ): Promise<CaptureOpenResult> {
    return this.request<CaptureOpenResult>({
      action: "open",
      videoDeviceId,
      audioDeviceId,
      videoMode,
    });
  }

  async getPreviewStatus(): Promise<CapturePreviewStatus> {
    return this.request<CapturePreviewStatus>({ action: "previewStatus" });
  }

  async closeStream(): Promise<void> {
    await this.request<null>({ action: "closeStream" });
  }

  async setPreviewAudio(muted: boolean, volume: number): Promise<void> {
    await this.request<null>({ action: "previewAudio", muted, volume });
  }

  async startManual(settings: AppSettings): Promise<RecordingSnapshot> {
    return this.request<RecordingSnapshot>({ action: "startManual", settings });
  }

  async stopRecording(): Promise<RecordingSnapshot> {
    return this.request<RecordingSnapshot>({ action: "stopRecording" });
  }

  async startMonitoring(settings: AppSettings): Promise<MonitoringSnapshot> {
    return this.request<MonitoringSnapshot>({ action: "startMonitoring", settings });
  }

  async stopMonitoring(): Promise<MonitoringSnapshot> {
    return this.request<MonitoringSnapshot>({ action: "stopMonitoring" });
  }

  private async request<T extends CaptureCommandResult>(
    command: CaptureCommandInput,
  ): Promise<T> {
    await this.ensureHost();
    const id = crypto.randomUUID();
    const payload = { ...command, id } as CaptureCommand;
    return new Promise<T>((resolve, reject) => {
      const send = () => {
        void emitTo(CAPTURE_WEBVIEW_LABEL, CAPTURE_COMMAND_EVENT, payload).catch(() => undefined);
      };
      const retry = window.setInterval(send, REQUEST_RETRY_MS);
      const retryStop = window.setTimeout(() => {
        window.clearInterval(retry);
      }, REQUEST_RETRY_WINDOW_MS);
      const timeout = window.setTimeout(() => {
        window.clearInterval(retry);
        window.clearTimeout(retryStop);
        this.pending.delete(id);
        reject(new Error("The isolated capture service did not respond."));
      }, requestTimeout(command));
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        retry,
        retryStop,
      });
      send();
    });
  }

  private async ensureHost(): Promise<Webview> {
    if (this.webview) return this.webview;
    if (this.creating) return this.creating;
    this.creating = (async () => {
      await this.installResponseListener();
      const existing = await Webview.getByLabel(CAPTURE_WEBVIEW_LABEL);
      if (existing) {
        this.webview = existing;
        return existing;
      }
      const bounds = this.stage?.getBoundingClientRect();
      const webview = new Webview(getCurrentWindow(), CAPTURE_WEBVIEW_LABEL, {
        url: "capture.html",
        x: Math.max(0, bounds?.left ?? 0),
        y: Math.max(0, bounds?.top ?? 0),
        width: Math.max(1, bounds?.width ?? 1),
        height: Math.max(1, bounds?.height ?? 1),
        focus: false,
        dragDropEnabled: false,
      });
      this.webview = webview;
      return webview;
    })().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  private async installResponseListener(): Promise<void> {
    if (this.responseUnlisten) return;
    this.responseUnlisten = await listen<CaptureResponse>(
      CAPTURE_RESPONSE_EVENT,
      ({ payload }) => {
        const pending = this.pending.get(payload.id);
        if (!pending) return;
        window.clearTimeout(pending.timeout);
        window.clearInterval(pending.retry);
        window.clearTimeout(pending.retryStop);
        this.pending.delete(payload.id);
        if (payload.ok) pending.resolve(payload.result ?? null);
        else pending.reject(new Error(payload.error ?? "The capture service failed."));
      },
    );
  }

  private async syncBounds(): Promise<void> {
    const stage = this.stage;
    const webview = this.webview;
    if (!stage || !webview) return;
    const bounds = stage.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return;
    await Promise.all([
      webview.setPosition(new LogicalPosition(bounds.left, bounds.top)),
      webview.setSize(new LogicalSize(bounds.width, bounds.height)),
    ]);
  }
}

export const captureBridge = new CaptureBridge();

function requestTimeout(command: CaptureCommandInput): number {
  return command.action === "stopRecording" || command.action === "stopMonitoring"
    ? FINALIZATION_REQUEST_TIMEOUT_MS
    : DEFAULT_REQUEST_TIMEOUT_MS;
}
