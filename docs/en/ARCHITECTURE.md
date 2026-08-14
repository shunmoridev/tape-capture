# TapeCapture architecture

## 1. System structure

```text
src/
  capture/                   isolated capture bridge, MediaStream owner and recorder
  settings/                  native settings overlay protocol and positioning
  recordingSettings/         recording timing settings overlay
  components/                one-screen setup, preview, status and telemetry
  api.ts                     typed Tauri IPC wrappers
  *Host.ts                   dedicated child-WebView runtimes (capture, settings, recording settings)
src-tauri/src/
  analysis/                  explainable frame feature rules
  recording/                 file sessions, finalization and state definitions
  monitoring/                automatic start/stop state machine
  commands/                  narrow Tauri command boundary
  infrastructure/            settings, FFmpeg resolution, recording indicator, storage
```

The system WebView's standard `MediaDevices` API is the exclusive capture
boundary. It discovers inputs and opens one audio/video `MediaStream`, while the
WebView and operating system handle permission prompts and device drivers.
Application code does not open capture devices through platform-specific camera
APIs.

## 2. Stream topology

One persistent `MediaStream`, owned by a dedicated child WebView rather than the
React control surface, fans out to three consumers:

1. A `<video>` element displays the device output continuously, with independent
   speaker volume and mute controls. Monitoring and recording never replace its
   `srcObject` and never hide the preview; speaker settings never alter the
   recorded audio track.
2. A 160x120 offscreen canvas samples sequentially at 2-5 fps for content analysis.
   It exists only for classification and is not the preview source.
3. One continuous `MediaRecorder` produces one-second encoded chunks for the
   full automatic-monitoring session. During monitoring it keeps a bounded
   pre-roll ring; during recording the chunks are sent directly to Rust as raw
   binary IPC and appended to disk. Segment endings use `requestData()` as an
   encoded-chunk boundary and switch routing back to the pre-roll ring without
   stopping the recorder.

The first container initialization bytes are retained separately from the
bounded media ring. Pending writes apply backpressure at 32 MB and pre-roll is
also capped by bytes, so a slow disk cannot turn either queue into an unbounded
copy of the recording. Starting automatic recording writes the initialization
data and the configured amount of active start-confirmation media, beginning no
earlier than the first active observation. Because timestamps identify encoded
chunk ends, the first retained chunk provides up to one chunk of safety overlap.
Clearly inactive older chunks are omitted. The full recording is never
accumulated in JavaScript memory.

## 3. Responsibilities

- `CaptureBridge`: request/response boundary between the React control surface
  and the child WebView; it also keeps the native preview bounds synchronized.
- `MediaCaptureEngine`: device discovery, permissions, persistent stream,
  recorder lifetime, pre-roll chunks, preview attachment and analysis sampling.
- `ContentAnalyzer` (Rust): compute RMS-aware, explainable frame features from
  the sampled RGBA frame. It never renders preview images.
- `MonitoringManager` (Rust): own the debounced state machine and return explicit
  start/stop recording actions for each observation.
- `RecordingManager` (Rust): create one exclusive writable file session, append
  ordered raw chunks, expose size/elapsed status, and finalize sealed sessions
  in FIFO order while the next capture continues. Failed finalization retains a
  recoverable source and does not cancel later queued work.
- React: display snapshots and send user intents. Reloading or a render failure
  never stops capture; the child WebView and Rust state remain authoritative.

## 4. Automatic monitoring

The monitoring state machine is the single source of truth for automatic
recording. It receives a binary active/inactive signal from the analysis layer
and emits explicit `StartRecording` or `StopRecording` actions after the
configured confirmation period. The confirmation period can be interrupted by
the opposite signal, so a brief gap or flicker does not create a spurious file.

The monitoring manager owns the debounced state machine and returns explicit
start/stop recording actions for each observation. It does not own the capture
device, the recorder, or the file session.

On the first inactive observation during recording, the capture service flushes
an encoded boundary and the recording manager marks the resulting raw byte
offset. Capture continues normally throughout stop confirmation. If active
content returns, the tentative boundary is cleared and the short gap remains in
the same recording. If inactivity is confirmed, the raw file is truncated to
the marked boundary before sealing, excluding the confirmation interval from
the completed file. The boundary still includes normal analysis latency and the
encoded chunk that overlaps the first inactive observation.

## 5. Recording and finalization

The recording manager creates one exclusive writable file session at a time.
It appends ordered raw chunks, exposes size/elapsed status, and finalizes
sealed sessions in FIFO order while the next capture continues. Failed
finalization retains a recoverable source and does not cancel later queued work.

The finalization queue is persisted in the application-data directory as a
single JSON file rather than per-video sidecars. After an application
interruption, existing raw sources are restored to FIFO finalization
automatically on the next launch without prompting the user.

Finalizing an automatic segment immediately reserves and displays the next
output filename; the reservation is consumed by the following recording and
regenerated if another file takes that name first. The adjacent folder action
opens the destination through Tauri's cross-platform opener plugin.

Successful finalization publishes the requested video file. Queue and session
metadata remain in the application-data directory rather than beside the
recording.

Final output publication never replaces an existing file. On filesystems that
support hard links, the completed partial file is linked into place atomically
with create-if-absent semantics. On filesystems without hard links, such as
exFAT, TapeCapture falls back to opening the final path with create-new
semantics and copying the already validated partial file. The fallback final
path can be visible while it is copied, but a failed copy removes that
incomplete destination and retains the partial and recoverable raw source. If
another process claims the reserved name first, TapeCapture publishes under a
new unique name. In-memory reservations also exclude every active, queued,
processing, and recoverable session path.

The monitoring and recording command boundaries keep the native capture badge
active from monitoring start through monitoring stop, including every
automatic file segment, even if the React surface reloads. Manual recording
also activates the badge for the lifetime of its Rust file session.

Destination free space is reported as live telemetry.

The final ten seconds of every completed output are decoded successfully
before the recoverable raw source is deleted.

## 6. Validation

1. Verify camera/microphone permission behavior on packaged Windows, macOS and
   Linux builds.
2. Record at least one long tape on each WebView family and validate duration,
   A/V sync and final-frame decoding with `ffprobe`.
3. Test WebM and fragmented-MP4 pre-roll reconstruction across the supported
   MediaRecorder implementations.
4. Test device removal, permission revocation, disk-full behavior and recovery
   of the retained raw source.
5. Stress rapid automatic start/stop cycles while finalization is slower than
   capture, verifying FIFO output order and no missing frames at boundaries.
6. Publish to a hard-link-incompatible filesystem such as exFAT, verifying the
   no-clobber copy fallback and recovery after a failed copy.
7. Verify that confirmed inactive endings are truncated at the marked encoded
   boundary, cancelled stop confirmations remain intact, and automatic starts
   omit chunks older than the first active observation.

## 7. Deployment assumptions

- The preview is mandatory and always represents the live USB device output.
- Audio is paired automatically by a current `groupId`, then by a matching
  device label or the sole concrete audio candidate. Stale remembered IDs are
  replaced by the current match. The result can still be manually overridden or
  explicitly disabled. Changing that setting reopens the one shared stream.
- FFmpeg is an external runtime dependency and is not included in the current
  release packages. TapeCapture first checks `TAPECAPTURE_FFMPEG_PATH`, then a
  bundled `resources/bin/ffmpeg[.exe]`, and finally a separately installed
  `ffmpeg` from `PATH`. The bundled location supports a future release that
  explicitly includes the resource; the current Tauri bundle configuration
  does not do so.
- MKV remains the safe default; MP4 is available when requested.

## 8. Release build metadata

The version shown in the application is read at runtime from
`src-tauri/tauri.conf.json` through Tauri's application API. Release builds pass
the source commit as `VITE_COMMIT_SHA`, and the UI displays its first eight
characters.

For a GitHub Actions release build:

```yaml
- name: Build release assets
  run: pnpm tauri build
  env:
    VITE_COMMIT_SHA: ${{ github.sha }}
```

The same environment variable can be added to the `env` block of
`tauri-apps/tauri-action`. Local builds without it display `dev`.
