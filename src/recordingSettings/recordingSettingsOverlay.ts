import { emitTo } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  RECORDING_SETTINGS_STATE_EVENT,
  RECORDING_SETTINGS_WEBVIEW_LABEL,
  type RecordingSettingsOverlayState,
} from "./recordingSettingsProtocol";

class RecordingSettingsOverlay {
  private webview: Webview | null = null;
  private openState = false;

  constructor() {
    window.addEventListener("resize", () => {
      if (this.openState) void this.resize();
    });
  }

  async open(state: RecordingSettingsOverlayState): Promise<void> {
    this.openState = true;
    const existing = await this.findWebview();
    if (!existing) {
      this.createWebview();
      return;
    }
    await this.resize();
    await this.sync(state);
  }

  async close(): Promise<void> {
    this.openState = false;
    const webview = await this.findWebview();
    if (!webview) return;
    await webview.setSize(new LogicalSize(1, 1));
    await webview.setPosition(new LogicalPosition(window.innerWidth, window.innerHeight));
  }

  async sync(state: RecordingSettingsOverlayState): Promise<void> {
    if (!this.webview) return;
    await emitTo(RECORDING_SETTINGS_WEBVIEW_LABEL, RECORDING_SETTINGS_STATE_EVENT, state);
  }

  private async findWebview(): Promise<Webview | null> {
    if (this.webview) return this.webview;
    this.webview = await Webview.getByLabel(RECORDING_SETTINGS_WEBVIEW_LABEL);
    return this.webview;
  }

  private createWebview(): void {
    this.webview = new Webview(getCurrentWindow(), RECORDING_SETTINGS_WEBVIEW_LABEL, {
      url: "recording-settings.html",
      x: 0,
      y: 0,
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
      focus: true,
      transparent: true,
      dragDropEnabled: false,
    });
  }

  private async resize(): Promise<void> {
    const webview = await this.findWebview();
    if (!webview) return;
    await Promise.all([
      webview.setPosition(new LogicalPosition(0, 0)),
      webview.setSize(new LogicalSize(
        Math.max(1, window.innerWidth),
        Math.max(1, window.innerHeight),
      )),
    ]);
  }
}

export const recordingSettingsOverlay = new RecordingSettingsOverlay();
