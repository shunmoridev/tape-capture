# UI design

TapeCapture uses a quiet, focused desktop-tool character. Use semantic color
tokens, compact controls, visible focus, and clear status language. The preview
remains dark in every theme.

- Default appearance follows the operating system; light and dark are explicit
  alternatives.
- Global preferences such as language and appearance live in the top-right gear
  popover. Frequently used source and output choices remain in the setup panel.
  Automatic-recording timing is grouped in a focused modal opened from the
  settings button beside the primary recording action.
- User-facing actions describe outcomes such as "automatic recording" and
  "include the beginning"; implementation terms such as monitoring and
  pre-roll stay out of primary controls.
- Automatic and immediate recording are modes in one select, not competing
  start buttons. Starting automatic recording shows an indeterminate left-to-
  right preparation fill until the capture service is actually ready. A compact
  information control beside the mode label explains automatic start/stop,
  immediate recording, and that pre-roll begins only after automatic recording
  has been started.
- Preview state and audio controls sit below the picture like a familiar media
  player. The live indicator is immediately left of the audio controls and
  changes from green live input to red recording only while a file is being
  recorded.
  Global settings open in their own small native WebView above the preview,
  synchronized by events with the React control surface. It never owns capture
  state and closing it never hides or disturbs the preview.
- Blue is the primary action and monitoring color, red is reserved for recording
  or destructive stop actions, amber communicates a recoverable warning.
- While automatic monitoring or manual recording is active, the taskbar or Dock
  icon carries a red capture badge driven by Rust state, not React state.
- Compact circled information controls explain consequential choices such as
  output container and quality without making the setup form permanently dense.
- Keep visible supporting text at 11px or larger and ordinary labels and
  controls at 12px or larger. Compactness must come from spacing and hierarchy,
  not text that requires users to lean toward the screen.
- Status always includes a user-facing phrase. Raw enum names may appear only as
  secondary diagnostic text.
- Capture state and file-saving state are shown independently. Stopping
  automatic recording returns capture to idle immediately while a compact
  saving indicator shows the active conversion and queued file count. A failed
  conversion keeps and identifies its recoverable raw source without blocking
  later queued conversions.
- Disable source and output settings while monitoring or recording.
- Avoid dashboard clutter: prominent live state and preview, compact setup and
  telemetry panels, progressive disclosure for detection tuning.
- All controls need keyboard focus styles and all motion must respect
  `prefers-reduced-motion`.
- A reserved next-file path includes a compact folder action beside its label
  so users can open the destination without navigating through global settings.