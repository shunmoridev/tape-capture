# TapeCapture project context

@docs/en/PRODUCT-PHILOSOPHY.md
@docs/en/UI_DESIGN.md
@docs/en/ARCHITECTURE.md

Keep capture cross-platform through the system WebView `MediaStream`. Do not add
DirectShow, Media Foundation, AVFoundation, or V4L2 calls to application code;
FFmpeg is used only after capture for finalization and validation. Preserve
manual recording controls as a fallback for automatic detection.
