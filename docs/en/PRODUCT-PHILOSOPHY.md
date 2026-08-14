# Product philosophy

TapeCapture is a focused ingest appliance: the user
chooses inputs and a destination, starts monitoring, plays a tape, and can then
leave the application alone.

Automation uses **automatic detection with an explicit user override** and must
remain inspectable: monitoring, confirmation,
recording, finalization, warnings, and errors are visible rather than hidden.
Stopping automatic recording stops capture, not already-queued file saving.
Queued finalization continues without a confirmation prompt, while recoverable
raw sources and failures remain visible.

The main experience should stay on one screen. Advanced settings are secondary
to source selection, preview, current state, storage safety, and one explicit
recording-mode choice followed by one primary start/stop action.

The application distinguishes device connectivity, frame availability, audio
availability, and active content. A blue frame can be a perfectly valid device
signal while still being inactive content.

Physical capture hardware may expose video and audio as separate operating-system
devices. TapeCapture should suggest and remember that pairing while keeping the
relationship visible and editable. Video-only recording remains an explicit
choice, never an accidental result of a missing audio device.