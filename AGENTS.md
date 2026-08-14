# TapeCapture agent guide

Read `docs/en/PRODUCT-PHILOSOPHY.md`, `docs/en/UI_DESIGN.md`, and
`docs/en/ARCHITECTURE.md` before making product or architecture changes.

- Preserve the auto-detect plus user-override interaction model.
- Keep capture ownership in `src/capture`, and keep analysis, recording state,
  file writing, and post-processing behind Rust module boundaries. Do not put
  recording state transitions in React components.
- Keep FFmpeg arguments as arrays; never build a shell command string.
- Keep every phase runnable and testable before starting the next phase.
- The system WebView `MediaStream` is the single capture owner. Keep OS-specific
  camera APIs out of application code; FFmpeg is post-processing only.
