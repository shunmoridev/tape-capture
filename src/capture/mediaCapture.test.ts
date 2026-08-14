import { describe, expect, it } from "vitest";
import {
  captureAudioConstraints,
  MediaCaptureEngine,
  pruneBufferedChunks,
  selectStartBufferedChunks,
  splitContainerInitialization,
  suggestAudioDevice,
  videoModeProbeFrameRates,
} from "./mediaCapture";

describe("MediaCaptureEngine transitions", () => {
  it("serializes a stop transition behind an in-flight start transition", async () => {
    const engine = new MediaCaptureEngine();
    const order: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });

    const start = (engine as unknown as {
      runTransition: <T>(operation: () => Promise<T>) => Promise<T>;
    }).runTransition(async () => {
      order.push("start-begin");
      await startGate;
      order.push("start-end");
    });
    const stop = (engine as unknown as {
      runTransition: <T>(operation: () => Promise<T>) => Promise<T>;
    }).runTransition(async () => {
      order.push("stop");
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start-begin"]);
    releaseStart();
    await Promise.all([start, stop]);
    expect(order).toEqual(["start-begin", "start-end", "stop"]);
  });
});

function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label: string,
  groupId = "",
): MediaDeviceInfo {
  return {
    kind,
    deviceId,
    label,
    groupId,
    toJSON: () => ({ kind, deviceId, label, groupId }),
  };
}

describe("suggestAudioDevice", () => {
  it("prefers the audio input from the same hardware group", () => {
    const video = device("videoinput", "video", "USB Capture Video", "capture-card");
    const audio = [
      device("audioinput", "other", "Microphone", "microphone"),
      device("audioinput", "paired", "USB Capture Audio", "capture-card"),
    ];

    expect(suggestAudioDevice(video, audio)?.deviceId).toBe("paired");
  });

  it("falls back to meaningful label similarity", () => {
    const video = device("videoinput", "video", "Acme VHS Bridge Video");
    const audio = [
      device("audioinput", "other", "Desk Microphone"),
      device("audioinput", "paired", "Acme VHS Bridge Audio"),
    ];

    expect(suggestAudioDevice(video, audio)?.deviceId).toBe("paired");
  });
});

describe("captureAudioConstraints", () => {
  it("requests unprocessed stereo PCM-style capture when supported", () => {
    const constraints = captureAudioConstraints("audio-device", {
      autoGainControl: true,
      channelCount: true,
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: true,
      sampleSize: true,
    });

    expect(constraints).toEqual({
      deviceId: { exact: "audio-device" },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: { ideal: 48_000 },
      sampleSize: { ideal: 16 },
      channelCount: { ideal: 2 },
    });
  });
});

describe("videoModeProbeFrameRates", () => {
  it("keeps NTSC fractional and integer frame rates", () => {
    expect(videoModeProbeFrameRates(720, 480, 60)).toEqual([29.97, 30, 60]);
  });
});

describe("pruneBufferedChunks", () => {
  it("drops a single chunk that exceeds the byte cap", () => {
    const oversized = [{ bytes: new Uint8Array(12), capturedAt: 100 }];

    expect(pruneBufferedChunks(oversized, 12, 0, 8)).toEqual({
      chunks: [],
      totalBytes: 0,
    });
  });

  it("removes expired chunks while preserving order", () => {
    const chunks = [
      { bytes: new Uint8Array([1]), capturedAt: 100 },
      { bytes: new Uint8Array([2]), capturedAt: 200 },
    ];

    const result = pruneBufferedChunks(chunks, 2, 150, 10);
    expect(result.chunks.map((chunk) => chunk.bytes[0])).toEqual([2]);
    expect(result.totalBytes).toBe(1);
  });
});

describe("selectStartBufferedChunks", () => {
  const chunks = [
    { bytes: new Uint8Array([1]), capturedAt: 2_000 },
    { bytes: new Uint8Array([2]), capturedAt: 3_000 },
    { bytes: new Uint8Array([3]), capturedAt: 4_000 },
    { bytes: new Uint8Array([4]), capturedAt: 5_000 },
    { bytes: new Uint8Array([5]), capturedAt: 6_000 },
  ];

  it("drops clearly inactive chunks before the first active observation", () => {
    const selected = selectStartBufferedChunks(chunks, 4_000, 6_000, 5_000);
    expect(selected.map((chunk) => chunk.bytes[0])).toEqual([3, 4, 5]);
  });

  it("still respects a shorter configured beginning-recovery window", () => {
    const selected = selectStartBufferedChunks(chunks, 3_000, 6_000, 1_000);
    expect(selected.map((chunk) => chunk.bytes[0])).toEqual([4, 5]);
  });

  it("keeps the existing rolling-window behavior for a manual override", () => {
    const selected = selectStartBufferedChunks(chunks, null, 6_000, 1_000);
    expect(selected.map((chunk) => chunk.bytes[0])).toEqual([4, 5]);
  });
});

describe("splitContainerInitialization", () => {
  it("splits WebM initialization before the first Cluster", () => {
    const bytes = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3,
      0x1f, 0x43, 0xb6, 0x75,
      0xaa, 0xbb,
    ]);

    const result = splitContainerInitialization(bytes, "video/webm");
    expect([...result.initialization]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect([...result.media]).toEqual([0x1f, 0x43, 0xb6, 0x75, 0xaa, 0xbb]);
  });

  it("retains an unrecognized first chunk as initialization data", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const result = splitContainerInitialization(bytes, "video/webm");
    expect([...result.initialization]).toEqual([1, 2, 3, 4]);
    expect(result.media).toHaveLength(0);
  });
});
