use crate::infrastructure::ffmpeg;
use crate::recording::RecordingState;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Instant;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingRequest {
    pub output_directory: String,
    pub output_container: String,
    pub quality_preset: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginRecordingResponse {
    pub session_id: String,
    pub snapshot: RecordingSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSnapshot {
    pub state: RecordingState,
    pub elapsed_ms: u64,
    pub current_file: Option<String>,
    pub next_file: Option<String>,
    pub current_file_size: u64,
    pub last_error: Option<String>,
    pub pending_finalizations: u32,
    pub finalization_active: bool,
    pub files_completed: u32,
    pub finalization_failures: u32,
    pub last_finalization_error: Option<String>,
    pub recoverable_file: Option<String>,
}

impl Default for RecordingSnapshot {
    fn default() -> Self {
        Self {
            state: RecordingState::Idle,
            elapsed_ms: 0,
            current_file: None,
            next_file: None,
            current_file_size: 0,
            last_error: None,
            pending_finalizations: 0,
            finalization_active: false,
            files_completed: 0,
            finalization_failures: 0,
            last_finalization_error: None,
            recoverable_file: None,
        }
    }
}

struct ActiveRecording {
    session_id: String,
    started_at: Instant,
    final_path: PathBuf,
    raw_path: PathBuf,
    writer: Option<BufWriter<File>>,
    bytes_written: u64,
    automatic_end_boundary: Option<u64>,
    output_container: String,
    quality_preset: String,
}

struct ReservedOutput {
    directory: PathBuf,
    container: String,
    path: PathBuf,
}

#[derive(Default)]
struct Inner {
    active: Option<ActiveRecording>,
    finalizing: HashMap<String, ActiveRecording>,
    finalization_order: VecDeque<String>,
    finalization_count: usize,
    finalization_active: bool,
    processing_recording: Option<PersistedRecording>,
    files_completed: u32,
    finalization_failures: u32,
    last_finalization_error: Option<String>,
    recoverable_file: Option<String>,
    recoverable_recordings: HashMap<String, ActiveRecording>,
    next_output: Option<ReservedOutput>,
    snapshot: RecordingSnapshot,
}

pub struct RecordingManager {
    inner: Mutex<Inner>,
    finalization_lock: Mutex<()>,
    queue_state_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRecording {
    session_id: String,
    final_path: PathBuf,
    raw_path: PathBuf,
    bytes_written: u64,
    output_container: String,
    quality_preset: String,
}

impl Default for RecordingManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            finalization_lock: Mutex::new(()),
            queue_state_path: None,
        }
    }
}

impl RecordingManager {
    pub fn with_recovery_queue(queue_state_path: PathBuf) -> Self {
        let mut inner = Inner::default();
        for persisted in load_persisted_recordings(&queue_state_path) {
            if !persisted.raw_path.is_file() {
                continue;
            }
            let session_id = persisted.session_id.clone();
            let bytes_written = fs::metadata(&persisted.raw_path)
                .map(|metadata| metadata.len())
                .unwrap_or(persisted.bytes_written);
            let active = ActiveRecording {
                session_id: session_id.clone(),
                started_at: Instant::now(),
                final_path: persisted.final_path,
                raw_path: persisted.raw_path,
                writer: None,
                bytes_written,
                automatic_end_boundary: None,
                output_container: persisted.output_container,
                quality_preset: persisted.quality_preset,
            };
            inner.finalization_order.push_back(session_id.clone());
            inner.finalizing.insert(session_id, active);
            inner.finalization_count = inner.finalization_count.saturating_add(1);
        }
        apply_finalization_status_to_inner(&mut inner);
        Self {
            inner: Mutex::new(inner),
            finalization_lock: Mutex::new(()),
            queue_state_path: Some(queue_state_path),
        }
    }

    pub fn last_queued_session(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.finalization_order.back().cloned())
    }

    pub fn begin(&self, request: StartRecordingRequest) -> Result<BeginRecordingResponse, String> {
        validate_request(&request)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Recording state is unavailable.".to_owned())?;
        if let Some(active) = inner.active.as_ref() {
            return Ok(BeginRecordingResponse {
                session_id: active.session_id.clone(),
                snapshot: snapshot_from_active(active, RecordingState::Recording, None),
            });
        }

        let output_directory = Path::new(&request.output_directory);
        fs::create_dir_all(output_directory)
            .map_err(|error| format!("Could not create the output directory: {error}"))?;
        let session_id = Uuid::new_v4().to_string();
        let final_path =
            select_output_path(&mut inner, output_directory, &request.output_container);
        let raw_extension = if request.mime_type.contains("mp4") {
            "mp4"
        } else {
            "webm"
        };
        let raw_path = output_directory.join(format!(".tapecapture-{session_id}.{raw_extension}"));
        let writer = create_raw_capture_file(&raw_path)
            .map(BufWriter::new)
            .map_err(|error| format!("Could not create the capture file: {error}"))?;
        let active = ActiveRecording {
            session_id: session_id.clone(),
            started_at: Instant::now(),
            final_path,
            raw_path,
            writer: Some(writer),
            bytes_written: 0,
            automatic_end_boundary: None,
            output_container: request.output_container,
            quality_preset: request.quality_preset,
        };
        let mut snapshot = snapshot_from_active(&active, RecordingState::Recording, None);
        apply_finalization_status(&inner, &mut snapshot);
        inner.snapshot = snapshot.clone();
        inner.active = Some(active);
        self.persist_queue(&inner);
        Ok(BeginRecordingResponse {
            session_id,
            snapshot,
        })
    }

    pub fn append(&self, session_id: &str, bytes: &[u8]) -> Result<RecordingSnapshot, String> {
        if bytes.is_empty() {
            return Ok(self.snapshot());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Recording state is unavailable.".to_owned())?;
        let active = inner
            .active
            .as_mut()
            .ok_or_else(|| "No recording is active.".to_owned())?;
        if active.session_id != session_id {
            return Err("The recording chunk belongs to an expired session.".to_owned());
        }
        active
            .writer
            .as_mut()
            .ok_or_else(|| "The recording writer is already closed.".to_owned())?
            .write_all(bytes)
            .map_err(|error| format!("Could not write the recording: {error}"))?;
        active.bytes_written = active.bytes_written.saturating_add(bytes.len() as u64);
        let mut snapshot = snapshot_from_active(active, RecordingState::Recording, None);
        apply_finalization_status(&inner, &mut snapshot);
        inner.snapshot = snapshot.clone();
        Ok(snapshot)
    }

    pub fn mark_automatic_end_boundary(&self, session_id: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Recording state is unavailable.".to_owned())?;
        let active = inner
            .active
            .as_mut()
            .ok_or_else(|| "No recording is active.".to_owned())?;
        if active.session_id != session_id {
            return Err("The recording boundary belongs to an expired session.".to_owned());
        }
        active
            .automatic_end_boundary
            .get_or_insert(active.bytes_written);
        Ok(())
    }

    pub fn clear_automatic_end_boundary(&self, session_id: &str) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Recording state is unavailable.".to_owned())?;
        let active = inner
            .active
            .as_mut()
            .ok_or_else(|| "No recording is active.".to_owned())?;
        if active.session_id != session_id {
            return Err("The recording boundary belongs to an expired session.".to_owned());
        }
        active.automatic_end_boundary = None;
        Ok(())
    }

    pub fn seal(&self, session_id: &str) -> Result<RecordingSnapshot, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Recording state is unavailable.".to_owned())?;
        if let Some(finalizing) = inner.finalizing.get(session_id) {
            return Ok(snapshot_from_active(
                finalizing,
                RecordingState::Finalizing,
                None,
            ));
        }
        let Some(mut active) = inner.active.take() else {
            return Ok(inner.snapshot.clone());
        };
        if active.session_id != session_id {
            inner.active = Some(active);
            return Err("The recording stop belongs to an expired session.".to_owned());
        }

        let flush_result = prepare_active_for_seal(&mut active);
        drop(active.writer.take());
        if let Err(error) = flush_result {
            inner.snapshot = RecordingSnapshot {
                state: RecordingState::Error,
                elapsed_ms: active.started_at.elapsed().as_millis() as u64,
                current_file: Some(active.raw_path.to_string_lossy().to_string()),
                next_file: None,
                current_file_size: active.bytes_written,
                last_error: Some(error.clone()),
                ..RecordingSnapshot::default()
            };
            return Err(error);
        }

        inner.next_output = Some(reserve_following_output(&inner, &active));
        inner.finalization_count = inner.finalization_count.saturating_add(1);
        inner
            .finalization_order
            .push_back(active.session_id.clone());
        let sealed_size = active.bytes_written;
        inner.finalizing.insert(active.session_id.clone(), active);
        let mut snapshot = RecordingSnapshot {
            state: RecordingState::Idle,
            current_file_size: sealed_size,
            ..inner.snapshot.clone()
        };
        apply_finalization_status(&inner, &mut snapshot);
        inner.snapshot = snapshot.clone();
        self.persist_queue(&inner);
        Ok(snapshot)
    }

    pub fn finish(&self, session_id: &str) -> Result<RecordingSnapshot, String> {
        let needs_seal = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "Recording state is unavailable.".to_owned())?;
            if inner.finalizing.contains_key(session_id) {
                false
            } else if let Some(active) = inner.active.as_ref() {
                if active.session_id != session_id {
                    return Err("The recording stop belongs to an expired session.".to_owned());
                }
                true
            } else {
                return Ok(inner.snapshot.clone());
            }
        };
        if needs_seal {
            self.seal(session_id)?;
        }

        let _finalization_guard = self
            .finalization_lock
            .lock()
            .map_err(|_| "Recording finalization is unavailable.".to_owned())?;
        loop {
            let (queued_session, active) = {
                let mut inner = self
                    .inner
                    .lock()
                    .map_err(|_| "Recording state is unavailable.".to_owned())?;
                let Some(queued_session) = inner.finalization_order.pop_front() else {
                    let mut snapshot = inner.snapshot.clone();
                    apply_finalization_status(&inner, &mut snapshot);
                    return Ok(snapshot);
                };
                inner.finalization_active = true;
                let active = inner
                    .finalizing
                    .remove(&queued_session)
                    .ok_or_else(|| "The queued recording is unavailable.".to_owned())?;
                inner.processing_recording = Some(PersistedRecording::from(&active));
                (queued_session, active)
            };

            let result = finalize_capture(&active);
            let (completed_file, final_size, finalization_error, recoverable_file) = match result {
                Ok(published_path) => {
                    let _ = fs::remove_file(&active.raw_path);
                    let final_size = fs::metadata(&published_path)
                        .map(|metadata| metadata.len())
                        .unwrap_or(active.bytes_written);
                    (
                        Some(published_path.to_string_lossy().to_string()),
                        final_size,
                        None,
                        None,
                    )
                }
                Err(error) => (
                    None,
                    active.bytes_written,
                    Some(error),
                    Some(active.raw_path.to_string_lossy().to_string()),
                ),
            };
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Recording state is unavailable.".to_owned())?;
            inner.finalization_active = false;
            inner.processing_recording = None;
            inner.finalization_count = inner.finalization_count.saturating_sub(1);
            let finalization_failed = finalization_error.is_some();
            if let Some(error) = finalization_error {
                inner.finalization_failures = inner.finalization_failures.saturating_add(1);
                inner.last_finalization_error = Some(error);
                inner.recoverable_file = recoverable_file.clone();
            } else {
                inner.files_completed = inner.files_completed.saturating_add(1);
            }
            let mut snapshot = if let Some(current) = inner.active.as_ref() {
                snapshot_from_active(current, RecordingState::Recording, None)
            } else {
                RecordingSnapshot {
                    state: RecordingState::Idle,
                    elapsed_ms: active.started_at.elapsed().as_millis() as u64,
                    current_file: completed_file.or(recoverable_file),
                    current_file_size: final_size,
                    ..RecordingSnapshot::default()
                }
            };
            snapshot.next_file = inner
                .next_output
                .as_ref()
                .map(|reserved| reserved.path.to_string_lossy().to_string());
            apply_finalization_status(&inner, &mut snapshot);
            inner.snapshot = snapshot.clone();
            if finalization_failed {
                inner
                    .recoverable_recordings
                    .insert(active.session_id.clone(), active);
            }
            self.persist_queue(&inner);
            if queued_session == session_id {
                return Ok(snapshot);
            }
        }
    }

    pub fn snapshot(&self) -> RecordingSnapshot {
        let Ok(mut inner) = self.inner.lock() else {
            return RecordingSnapshot {
                state: RecordingState::Error,
                last_error: Some("Recording status is unavailable.".to_owned()),
                ..RecordingSnapshot::default()
            };
        };
        if let Some(active) = inner.active.as_ref() {
            let mut snapshot = snapshot_from_active(active, RecordingState::Recording, None);
            apply_finalization_status(&inner, &mut snapshot);
            inner.snapshot = snapshot;
        } else {
            let mut snapshot = inner.snapshot.clone();
            apply_finalization_status(&inner, &mut snapshot);
            inner.snapshot = snapshot;
        }
        inner.snapshot.clone()
    }

    pub fn is_active(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.active.is_some() || inner.finalization_count > 0)
            .unwrap_or(false)
    }

    fn persist_queue(&self, inner: &Inner) {
        let Some(path) = self.queue_state_path.as_ref() else {
            return;
        };
        let mut recordings = inner
            .processing_recording
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        recordings.extend(
            inner
                .finalization_order
                .iter()
                .filter_map(|session_id| inner.finalizing.get(session_id))
                .map(PersistedRecording::from),
        );
        recordings.extend(inner.active.iter().map(PersistedRecording::from));
        recordings.extend(
            inner
                .recoverable_recordings
                .values()
                .map(PersistedRecording::from),
        );
        let _ = persist_recordings(path, &recordings);
    }
}

impl From<&ActiveRecording> for PersistedRecording {
    fn from(active: &ActiveRecording) -> Self {
        Self {
            session_id: active.session_id.clone(),
            final_path: active.final_path.clone(),
            raw_path: active.raw_path.clone(),
            bytes_written: active.bytes_written,
            output_container: active.output_container.clone(),
            quality_preset: active.quality_preset.clone(),
        }
    }
}

fn load_persisted_recordings(path: &Path) -> Vec<PersistedRecording> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn persist_recordings(path: &Path, recordings: &[PersistedRecording]) -> Result<(), String> {
    if recordings.is_empty() {
        if path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("Could not clear the recovery queue: {error}"))?;
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create the recovery queue directory: {error}"))?;
    }
    let bytes = serde_json::to_vec(recordings)
        .map_err(|error| format!("Could not encode the recovery queue: {error}"))?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes)
        .map_err(|error| format!("Could not write the recovery queue: {error}"))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Could not replace the recovery queue: {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not publish the recovery queue: {error}"))
}

fn apply_finalization_status_to_inner(inner: &mut Inner) {
    let mut snapshot = inner.snapshot.clone();
    apply_finalization_status(inner, &mut snapshot);
    inner.snapshot = snapshot;
}

fn validate_request(request: &StartRecordingRequest) -> Result<(), String> {
    if request.output_directory.trim().is_empty() {
        return Err("Choose a destination before recording.".to_owned());
    }
    if !matches!(request.output_container.as_str(), "mkv" | "mp4") {
        return Err("The output container must be MKV or MP4.".to_owned());
    }
    if !matches!(
        request.quality_preset.as_str(),
        "archival" | "balanced" | "compact"
    ) {
        return Err("The recording quality is invalid.".to_owned());
    }
    if request.mime_type.trim().is_empty() {
        return Err("The browser did not report a recording format.".to_owned());
    }
    Ok(())
}

fn snapshot_from_active(
    active: &ActiveRecording,
    state: RecordingState,
    last_error: Option<String>,
) -> RecordingSnapshot {
    RecordingSnapshot {
        state,
        elapsed_ms: active.started_at.elapsed().as_millis() as u64,
        current_file: Some(active.final_path.to_string_lossy().to_string()),
        next_file: None,
        current_file_size: active.bytes_written,
        last_error,
        ..RecordingSnapshot::default()
    }
}

fn apply_finalization_status(inner: &Inner, snapshot: &mut RecordingSnapshot) {
    snapshot.pending_finalizations = inner.finalization_count.min(u32::MAX as usize) as u32;
    snapshot.finalization_active = inner.finalization_active;
    snapshot.files_completed = inner.files_completed;
    snapshot.finalization_failures = inner.finalization_failures;
    snapshot.last_finalization_error = inner.last_finalization_error.clone();
    snapshot.recoverable_file = inner.recoverable_file.clone();
}

fn prepare_active_for_seal(active: &mut ActiveRecording) -> Result<(), String> {
    let writer = active
        .writer
        .as_mut()
        .ok_or_else(|| "The recording writer is already closed.".to_owned())?;
    writer.flush().map_err(|error| {
        format!(
            "Could not flush the recording. The recoverable source remains at {}. {error}",
            active.raw_path.display()
        )
    })?;
    if let Some(boundary) = active.automatic_end_boundary.take() {
        let boundary = boundary.min(active.bytes_written);
        writer.get_mut().set_len(boundary).map_err(|error| {
            format!(
                "Could not trim the confirmed inactive ending. The recoverable source remains at {}. {error}",
                active.raw_path.display()
            )
        })?;
        active.bytes_written = boundary;
    }
    Ok(())
}

fn next_output_path_avoiding(
    directory: &Path,
    container: &str,
    unavailable: impl Fn(&Path) -> bool,
) -> PathBuf {
    let stamp = Local::now().format("%Y%m%d_%H%M%S");
    for sequence in 1..=9999 {
        let candidate = directory.join(format!("TapeCapture_{stamp}_{sequence:03}.{container}"));
        if !candidate.exists() && !unavailable(&candidate) {
            return candidate;
        }
    }
    loop {
        let candidate = directory.join(format!("TapeCapture_{}.{}", Uuid::new_v4(), container));
        if !candidate.exists() && !unavailable(&candidate) {
            return candidate;
        }
    }
}

fn output_path_is_claimed(inner: &Inner, path: &Path) -> bool {
    inner
        .active
        .as_ref()
        .is_some_and(|active| active.final_path == path)
        || inner
            .finalizing
            .values()
            .any(|active| active.final_path == path)
        || inner
            .recoverable_recordings
            .values()
            .any(|active| active.final_path == path)
        || inner
            .processing_recording
            .as_ref()
            .is_some_and(|recording| recording.final_path == path)
        || inner
            .next_output
            .as_ref()
            .is_some_and(|reserved| reserved.path == path)
}

fn select_output_path(inner: &mut Inner, directory: &Path, container: &str) -> PathBuf {
    if let Some(reserved) = inner.next_output.take() {
        if reserved.directory == directory
            && reserved.container == container
            && !reserved.path.exists()
            && !output_path_is_claimed(inner, &reserved.path)
        {
            return reserved.path;
        }
    }
    next_output_path_avoiding(directory, container, |path| {
        output_path_is_claimed(inner, path)
    })
}

fn reserve_following_output(inner: &Inner, active: &ActiveRecording) -> ReservedOutput {
    let directory = active
        .final_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    ReservedOutput {
        path: next_output_path_avoiding(&directory, &active.output_container, |path| {
            path == active.final_path || output_path_is_claimed(inner, path)
        }),
        directory,
        container: active.output_container.clone(),
    }
}

fn create_raw_capture_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        options.attributes(FILE_ATTRIBUTE_HIDDEN);
    }
    options.open(path)
}

fn finalize_capture(active: &ActiveRecording) -> Result<PathBuf, String> {
    if active.bytes_written == 0 {
        return Err("The capture device produced no recording data.".to_owned());
    }
    let partial_path = active
        .raw_path
        .with_extension(format!("partial.{}", active.output_container));
    let args = finalization_args(
        &active.raw_path,
        &partial_path,
        &active.output_container,
        &active.quality_preset,
    );
    let output = ffmpeg::command()
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start FFmpeg finalization: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let _ = fs::remove_file(&partial_path);
        return Err(format!(
            "FFmpeg could not finalize the capture. The recoverable source remains at {}. {}",
            active.raw_path.display(),
            detail
        ));
    }
    if let Err(error) = validate_finalized_capture(&partial_path) {
        let _ = fs::remove_file(&partial_path);
        return Err(format!(
            "The finalized video did not pass validation. The recoverable source remains at {}. {error}",
            active.raw_path.display()
        ));
    }
    publish_finalized_capture(
        &partial_path,
        &active.final_path,
        &active.output_container,
    )
    .map_err(|error| {
        format!(
            "Could not publish the finalized recording. The recoverable source remains at {}. {error}",
            active.raw_path.display()
        )
    })
}

fn publish_finalized_capture(
    partial_path: &Path,
    preferred_path: &Path,
    output_container: &str,
) -> std::io::Result<PathBuf> {
    let directory = preferred_path.parent().unwrap_or_else(|| Path::new("."));
    let mut candidate = preferred_path.to_path_buf();
    loop {
        match publish_without_overwrite(partial_path, &candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                candidate = directory.join(format!(
                    "TapeCapture_{}.{}",
                    Uuid::new_v4(),
                    output_container
                ));
            }
            Err(error) => return Err(error),
        }
    }
}

fn publish_without_overwrite(partial_path: &Path, final_path: &Path) -> std::io::Result<()> {
    publish_without_overwrite_using(partial_path, final_path, |source, destination| {
        fs::hard_link(source, destination)
    })
}

fn publish_without_overwrite_using<F>(
    partial_path: &Path,
    final_path: &Path,
    hard_link: F,
) -> std::io::Result<()>
where
    F: FnOnce(&Path, &Path) -> std::io::Result<()>,
{
    // Hard links publish the completed file atomically and fail if another
    // process claimed the destination. Filesystems such as exFAT do not
    // support them, so retain no-clobber behavior with a create-new copy.
    match hard_link(partial_path, final_path) {
        Ok(()) => {
            let _ = fs::remove_file(partial_path);
            Ok(())
        }
        Err(error) if hard_link_is_unsupported(&error) => {
            copy_without_overwrite(partial_path, final_path)
        }
        Err(error) => Err(error),
    }
}

fn hard_link_is_unsupported(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::Unsupported | std::io::ErrorKind::PermissionDenied
    ) {
        return true;
    }

    #[cfg(windows)]
    {
        // CreateHardLinkW reports ERROR_INVALID_FUNCTION on exFAT and some
        // removable drives, and ERROR_NOT_SUPPORTED on other providers.
        matches!(error.raw_os_error(), Some(1 | 50))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn copy_without_overwrite(partial_path: &Path, final_path: &Path) -> std::io::Result<()> {
    let mut source = File::open(partial_path)?;
    let mut destination = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(final_path)?;
    let result = io::copy(&mut source, &mut destination).and_then(|_| destination.sync_all());
    drop(destination);

    if let Err(error) = result {
        let _ = fs::remove_file(final_path);
        return Err(error);
    }

    let _ = fs::remove_file(partial_path);
    Ok(())
}

fn finalization_args(
    raw_path: &Path,
    partial_path: &Path,
    output_container: &str,
    quality_preset: &str,
) -> Vec<String> {
    let (preset, crf) = match quality_preset {
        "archival" => ("medium", "16"),
        "compact" => ("veryfast", "24"),
        _ => ("fast", "19"),
    };
    let mut args = vec![
        "-hide_banner".to_owned(),
        "-loglevel".to_owned(),
        "error".to_owned(),
        "-y".to_owned(),
        "-fflags".to_owned(),
        "+genpts".to_owned(),
        "-i".to_owned(),
        raw_path.to_string_lossy().to_string(),
        "-map".to_owned(),
        "0:v:0".to_owned(),
        "-map".to_owned(),
        "0:a:0?".to_owned(),
        "-c:v".to_owned(),
        "libx264".to_owned(),
        "-preset".to_owned(),
        preset.to_owned(),
        "-crf".to_owned(),
        crf.to_owned(),
        "-pix_fmt".to_owned(),
        "yuv420p".to_owned(),
        "-c:a".to_owned(),
        "aac".to_owned(),
        "-b:a".to_owned(),
        "192k".to_owned(),
    ];
    if output_container == "mp4" {
        args.extend(["-movflags".to_owned(), "+faststart".to_owned()]);
    }
    args.push(partial_path.to_string_lossy().to_string());
    args
}

fn validate_finalized_capture(path: &Path) -> Result<(), String> {
    let size = fs::metadata(path)
        .map_err(|error| format!("Could not inspect the finalized video: {error}"))?
        .len();
    if size == 0 {
        return Err("FFmpeg produced an empty file.".to_owned());
    }
    let path_text = path.to_string_lossy().to_string();
    let args = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-sseof",
        "-10",
        "-i",
        path_text.as_str(),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-t",
        "10",
        "-f",
        "null",
        "-",
    ];
    let output = ffmpeg::command()
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not start finalized video validation: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(format!(
            "FFmpeg could not decode the end of the video. {detail}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_container() {
        let request = StartRecordingRequest {
            output_directory: "C:\\captures".to_owned(),
            output_container: "avi".to_owned(),
            quality_preset: "balanced".to_owned(),
            mime_type: "video/webm".to_owned(),
        };
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn finalization_uses_compatible_h264_pixel_format() {
        let args = finalization_args(
            Path::new("source.webm"),
            Path::new("output.partial.mp4"),
            "mp4",
            "balanced",
        );
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(args.windows(2).any(|pair| pair == ["-pix_fmt", "yuv420p"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "aac"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-movflags", "+faststart"]));
    }

    #[test]
    fn reserved_name_is_used_once_then_advanced_if_taken() {
        let directory = std::env::temp_dir().join(format!("tapecapture-name-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let reserved_path = directory.join("TapeCapture_reserved_001.mkv");
        let mut inner = Inner {
            next_output: Some(ReservedOutput {
                directory: directory.clone(),
                container: "mkv".to_owned(),
                path: reserved_path.clone(),
            }),
            ..Inner::default()
        };

        assert_eq!(
            select_output_path(&mut inner, &directory, "mkv"),
            reserved_path
        );

        let occupied = next_output_path_avoiding(&directory, "mkv", |_| false);
        fs::write(&occupied, []).unwrap();
        inner.next_output = Some(ReservedOutput {
            directory: directory.clone(),
            container: "mkv".to_owned(),
            path: occupied.clone(),
        });
        let advanced = select_output_path(&mut inner, &directory, "mkv");
        assert_ne!(advanced, occupied);
        assert!(!advanced.exists());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn sealing_releases_capture_slot_and_reserves_the_next_output() {
        let directory = std::env::temp_dir().join(format!("tapecapture-seal-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        {
            let manager = RecordingManager::default();
            let request = || StartRecordingRequest {
                output_directory: directory.to_string_lossy().to_string(),
                output_container: "mkv".to_owned(),
                quality_preset: "balanced".to_owned(),
                mime_type: "video/webm".to_owned(),
            };
            let first = manager.begin(request()).unwrap();
            let sealed = manager.seal(&first.session_id).unwrap();
            assert_eq!(sealed.state, RecordingState::Idle);
            assert_eq!(sealed.pending_finalizations, 1);
            let reserved = manager
                .inner
                .lock()
                .unwrap()
                .next_output
                .as_ref()
                .unwrap()
                .path
                .clone();
            assert_ne!(
                first.snapshot.current_file.as_deref(),
                Some(reserved.to_string_lossy().as_ref())
            );

            let second = manager.begin(request()).unwrap();
            assert_ne!(second.session_id, first.session_id);
            assert_eq!(
                second.snapshot.current_file.as_deref(),
                Some(reserved.to_string_lossy().as_ref())
            );
            assert_eq!(manager.snapshot().state, RecordingState::Recording);
            let second_sealed = manager.seal(&second.session_id).unwrap();
            assert_eq!(second_sealed.pending_finalizations, 2);
            let queue = manager.inner.lock().unwrap();
            assert_eq!(
                queue.finalization_order.iter().cloned().collect::<Vec<_>>(),
                vec![first.session_id, second.session_id]
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn confirmed_automatic_end_boundary_removes_the_inactive_tail() {
        let directory =
            std::env::temp_dir().join(format!("tapecapture-boundary-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let manager = RecordingManager::default();
        let response = manager
            .begin(StartRecordingRequest {
                output_directory: directory.to_string_lossy().to_string(),
                output_container: "mkv".to_owned(),
                quality_preset: "balanced".to_owned(),
                mime_type: "video/webm".to_owned(),
            })
            .unwrap();
        manager
            .append(&response.session_id, b"active content")
            .unwrap();
        manager
            .mark_automatic_end_boundary(&response.session_id)
            .unwrap();
        manager
            .append(&response.session_id, b"inactive tail")
            .unwrap();

        let sealed = manager.seal(&response.session_id).unwrap();
        let raw_path = manager
            .inner
            .lock()
            .unwrap()
            .finalizing
            .get(&response.session_id)
            .unwrap()
            .raw_path
            .clone();
        assert_eq!(fs::read(raw_path).unwrap(), b"active content");
        assert_eq!(sealed.current_file_size, b"active content".len() as u64);

        drop(manager);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelled_automatic_end_boundary_preserves_the_short_gap() {
        let directory =
            std::env::temp_dir().join(format!("tapecapture-boundary-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let manager = RecordingManager::default();
        let response = manager
            .begin(StartRecordingRequest {
                output_directory: directory.to_string_lossy().to_string(),
                output_container: "mkv".to_owned(),
                quality_preset: "balanced".to_owned(),
                mime_type: "video/webm".to_owned(),
            })
            .unwrap();
        manager.append(&response.session_id, b"active").unwrap();
        manager
            .mark_automatic_end_boundary(&response.session_id)
            .unwrap();
        manager.append(&response.session_id, b"short gap").unwrap();
        manager
            .clear_automatic_end_boundary(&response.session_id)
            .unwrap();
        manager
            .append(&response.session_id, b"active again")
            .unwrap();

        manager.seal(&response.session_id).unwrap();
        let raw_path = manager
            .inner
            .lock()
            .unwrap()
            .finalizing
            .get(&response.session_id)
            .unwrap()
            .raw_path
            .clone();
        assert_eq!(fs::read(raw_path).unwrap(), b"activeshort gapactive again");

        drop(manager);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn publishing_never_overwrites_a_target_taken_after_reservation() {
        let directory =
            std::env::temp_dir().join(format!("tapecapture-publish-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let partial_path = directory.join("completed.partial.mkv");
        let preferred_path = directory.join("TapeCapture_reserved_001.mkv");
        fs::write(&partial_path, b"new recording").unwrap();
        fs::write(&preferred_path, b"existing recording").unwrap();

        let published = publish_finalized_capture(&partial_path, &preferred_path, "mkv").unwrap();

        assert_ne!(published, preferred_path);
        assert_eq!(fs::read(&preferred_path).unwrap(), b"existing recording");
        assert_eq!(fs::read(&published).unwrap(), b"new recording");
        assert!(!partial_path.exists());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn publishing_falls_back_to_a_no_clobber_copy_when_links_are_unsupported() {
        let directory =
            std::env::temp_dir().join(format!("tapecapture-copy-fallback-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let partial_path = directory.join("completed.partial.mkv");
        let final_path = directory.join("TapeCapture_001.mkv");
        fs::write(&partial_path, b"validated recording").unwrap();

        publish_without_overwrite_using(&partial_path, &final_path, |_, _| {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "hard links are unavailable",
            ))
        })
        .unwrap();

        assert_eq!(fs::read(&final_path).unwrap(), b"validated recording");
        assert!(!partial_path.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn copy_fallback_never_overwrites_an_existing_target() {
        let directory =
            std::env::temp_dir().join(format!("tapecapture-copy-no-clobber-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let partial_path = directory.join("completed.partial.mkv");
        let final_path = directory.join("TapeCapture_001.mkv");
        fs::write(&partial_path, b"new recording").unwrap();
        fs::write(&final_path, b"existing recording").unwrap();

        let error = copy_without_overwrite(&partial_path, &final_path).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&final_path).unwrap(), b"existing recording");
        assert_eq!(fs::read(&partial_path).unwrap(), b"new recording");
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_exfat_invalid_function_error_enables_copy_fallback() {
        assert!(hard_link_is_unsupported(&io::Error::from_raw_os_error(1)));
    }

    #[test]
    fn restores_an_interrupted_active_capture_into_the_fifo_queue() {
        let directory =
            std::env::temp_dir().join(format!("tapecapture-recovery-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let queue_path = directory.join("queue.json");
        let session_id;
        {
            let manager = RecordingManager::with_recovery_queue(queue_path.clone());
            let response = manager
                .begin(StartRecordingRequest {
                    output_directory: directory.to_string_lossy().to_string(),
                    output_container: "mkv".to_owned(),
                    quality_preset: "balanced".to_owned(),
                    mime_type: "video/webm".to_owned(),
                })
                .unwrap();
            session_id = response.session_id;
            manager.append(&session_id, b"recoverable bytes").unwrap();
            assert!(queue_path.is_file());
        }

        let recovered = RecordingManager::with_recovery_queue(queue_path);
        let snapshot = recovered.snapshot();
        assert_eq!(snapshot.pending_finalizations, 1);
        assert_eq!(
            recovered.last_queued_session().as_deref(),
            Some(session_id.as_str())
        );
        assert!(recovered
            .inner
            .lock()
            .unwrap()
            .finalizing
            .get(&session_id)
            .is_some_and(|active| active.bytes_written > 0));

        drop(recovered);
        fs::remove_dir_all(directory).unwrap();
    }
}
