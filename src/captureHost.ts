import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { listMediaDevices, mediaCapture } from "./capture/mediaCapture";
import {
  CAPTURE_COMMAND_EVENT,
  CAPTURE_RESPONSE_EVENT,
  type CaptureCommand,
  type CaptureCommandResult,
  type CaptureResponse,
} from "./capture/captureProtocol";
import { DISMISS_OVERLAYS_EVENT } from "./settings/settingsProtocol";
import "./captureHost.css";

const video = document.querySelector<HTMLVideoElement>("#capture-preview");
if (!video) throw new Error("The capture preview element is missing.");
mediaCapture.attachPreview(video);
window.addEventListener("pointerdown", () => void emit(DISMISS_OVERLAYS_EVENT));

const completed = new Map<string, CaptureResponse>();
const inFlight = new Map<string, Promise<CaptureResponse>>();

await listen<CaptureCommand>(CAPTURE_COMMAND_EVENT, async ({ payload }) => {
  const cached = completed.get(payload.id);
  if (cached) {
    await emitTo("main", CAPTURE_RESPONSE_EVENT, cached);
    return;
  }
  let pending = inFlight.get(payload.id);
  if (!pending) {
    pending = execute(payload)
      .then((result): CaptureResponse => ({ id: payload.id, ok: true, result }))
      .catch((cause): CaptureResponse => ({
        id: payload.id,
        ok: false,
        error: String(cause),
      }))
      .then((response) => {
        completed.set(payload.id, response);
        if (completed.size > 128) completed.delete(completed.keys().next().value!);
        return response;
      })
      .finally(() => {
        inFlight.delete(payload.id);
      });
    inFlight.set(payload.id, pending);
  }
  const response = await pending;
  await emitTo("main", CAPTURE_RESPONSE_EVENT, response);
});

async function execute(command: CaptureCommand): Promise<CaptureCommandResult> {
  switch (command.action) {
    case "listDevices":
      return listMediaDevices();
    case "open": {
      await mediaCapture.open(command.videoDeviceId, command.audioDeviceId, command.videoMode);
      return mediaCapture.getOpenResult();
    }
    case "previewStatus":
      return mediaCapture.getPreviewStatus();
    case "closeStream":
      mediaCapture.closeStream();
      return null;
    case "previewAudio":
      video.muted = command.muted;
      video.volume = Math.min(1, Math.max(0, command.volume));
      await video.play();
      return null;
    case "startManual":
      return mediaCapture.startManual(command.settings);
    case "stopRecording":
      return mediaCapture.stopRecording();
    case "startMonitoring":
      return mediaCapture.startMonitoring(command.settings);
    case "stopMonitoring":
      return mediaCapture.stopMonitoring();
  }
}
