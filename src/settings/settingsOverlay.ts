import { emitTo } from "@tauri-apps/api/event";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  SETTINGS_STATE_EVENT,
  SETTINGS_WEBVIEW_LABEL,
  type SettingsOverlayState,
} from "./settingsProtocol";

const OVERLAY_WIDTH = 176;
const OVERLAY_HEIGHT = 238;
const OVERLAY_GAP = 4;
const OVERLAY_RIGHT = 24;
const OVERLAY_TOP = 62;

class SettingsOverlay {
  private webview: Webview | null = null;

  async open(state: SettingsOverlayState, anchor?: DOMRect): Promise<void> {
    const existing = await this.findWebview();
    const x = Math.max(
      0,
      anchor?.right
        ? anchor.right - OVERLAY_WIDTH
        : window.innerWidth - OVERLAY_WIDTH - OVERLAY_RIGHT,
    );
    const y = Math.max(0, anchor?.bottom ? anchor.bottom + OVERLAY_GAP : OVERLAY_TOP);
    if (!existing) {
      this.createWebview(x, y);
      return;
    }
    await existing.setSize(new LogicalSize(OVERLAY_WIDTH, OVERLAY_HEIGHT));
    await existing.setPosition(new LogicalPosition(x, y));
    await this.sync(state);
  }

  async close(): Promise<void> {
    const webview = await this.findWebview();
    if (!webview) return;
    await webview.setSize(new LogicalSize(1, 1));
    await webview.setPosition(new LogicalPosition(window.innerWidth, 0));
  }

  async sync(state: SettingsOverlayState): Promise<void> {
    if (!this.webview) return;
    await emitTo(SETTINGS_WEBVIEW_LABEL, SETTINGS_STATE_EVENT, state);
  }

  private async findWebview(): Promise<Webview | null> {
    if (this.webview) return this.webview;
    this.webview = await Webview.getByLabel(SETTINGS_WEBVIEW_LABEL);
    return this.webview;
  }

  private createWebview(x: number, y: number): void {
    this.webview = new Webview(getCurrentWindow(), SETTINGS_WEBVIEW_LABEL, {
      url: "settings.html",
      x,
      y,
      width: OVERLAY_WIDTH,
      height: OVERLAY_HEIGHT,
      focus: true,
      dragDropEnabled: false,
    });
  }
}

export const settingsOverlay = new SettingsOverlay();
