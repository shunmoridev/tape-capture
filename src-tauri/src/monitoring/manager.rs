use crate::recording::{AutomationAction, AutomationStateMachine, RecordingState};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMonitoringRequest {
    pub start_confirmation_ms: u64,
    pub stop_confirmation_ms: u64,
    pub pre_roll_ms: u64,
    pub analysis_interval_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringSnapshot {
    pub running: bool,
    pub state: RecordingState,
    pub confirmation_elapsed_ms: u64,
    pub confirmation_target_ms: u64,
    pub last_error: Option<String>,
}

impl Default for MonitoringSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            state: RecordingState::Idle,
            confirmation_elapsed_ms: 0,
            confirmation_target_ms: 0,
            last_error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureAction {
    #[default]
    None,
    StartRecording,
    StopRecording,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitoringDecision {
    pub action: CaptureAction,
    pub snapshot: MonitoringSnapshot,
}

#[derive(Default)]
struct Inner {
    machine: Option<AutomationStateMachine>,
    started_at: Option<Instant>,
    start_confirmation_ms: u64,
    stop_confirmation_ms: u64,
    snapshot: MonitoringSnapshot,
}

#[derive(Default)]
pub struct MonitoringManager {
    inner: Mutex<Inner>,
}

impl MonitoringManager {
    pub fn start(&self, request: StartMonitoringRequest) -> Result<MonitoringSnapshot, String> {
        validate_request(&request)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Monitoring state is unavailable.".to_owned())?;
        if inner.snapshot.running {
            return Ok(inner.snapshot.clone());
        }
        inner.machine = Some(AutomationStateMachine::new(
            Duration::from_millis(request.start_confirmation_ms),
            Duration::from_millis(request.stop_confirmation_ms),
        ));
        inner.started_at = Some(Instant::now());
        inner.start_confirmation_ms = request.start_confirmation_ms;
        inner.stop_confirmation_ms = request.stop_confirmation_ms;
        inner.snapshot = MonitoringSnapshot {
            running: true,
            state: RecordingState::Monitoring,
            ..MonitoringSnapshot::default()
        };
        Ok(inner.snapshot.clone())
    }

    pub fn observe(&self, content_active: bool) -> Result<MonitoringDecision, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Monitoring state is unavailable.".to_owned())?;
        if !inner.snapshot.running {
            return Err("Automatic monitoring is not running.".to_owned());
        }
        let now = inner
            .started_at
            .map(|started| started.elapsed())
            .unwrap_or(Duration::ZERO);
        let machine = inner
            .machine
            .as_mut()
            .ok_or_else(|| "The monitoring state machine is unavailable.".to_owned())?;
        let action = match machine.observe(content_active, now) {
            AutomationAction::None => CaptureAction::None,
            AutomationAction::StartRecording => CaptureAction::StartRecording,
            AutomationAction::StopRecording => CaptureAction::StopRecording,
        };
        update_snapshot(&mut inner, now);
        Ok(MonitoringDecision {
            action,
            snapshot: inner.snapshot.clone(),
        })
    }

    pub fn manual_start(&self) -> Result<MonitoringDecision, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Monitoring state is unavailable.".to_owned())?;
        if !inner.snapshot.running {
            return Err("Automatic monitoring is not running.".to_owned());
        }
        let state = inner.snapshot.state;
        let action = if matches!(
            state,
            RecordingState::Recording | RecordingState::StopConfirming
        ) {
            CaptureAction::None
        } else {
            let machine = inner
                .machine
                .as_mut()
                .ok_or_else(|| "The monitoring state machine is unavailable.".to_owned())?;
            machine.force_recording();
            inner.snapshot.state = RecordingState::Recording;
            CaptureAction::StartRecording
        };
        Ok(MonitoringDecision {
            action,
            snapshot: inner.snapshot.clone(),
        })
    }

    pub fn manual_stop(&self) -> Result<MonitoringDecision, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Monitoring state is unavailable.".to_owned())?;
        if !inner.snapshot.running {
            return Err("Automatic monitoring is not running.".to_owned());
        }
        let action = if matches!(
            inner.snapshot.state,
            RecordingState::Recording | RecordingState::StopConfirming
        ) {
            if let Some(machine) = inner.machine.as_mut() {
                machine.begin_finalizing();
            }
            inner.snapshot.state = RecordingState::Finalizing;
            CaptureAction::StopRecording
        } else {
            CaptureAction::None
        };
        Ok(MonitoringDecision {
            action,
            snapshot: inner.snapshot.clone(),
        })
    }

    pub fn recording_started(&self) -> Result<MonitoringSnapshot, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Monitoring state is unavailable.".to_owned())?;
        if inner.snapshot.running {
            inner.snapshot.state = RecordingState::Recording;
        }
        Ok(inner.snapshot.clone())
    }

    pub fn recording_finalized(&self) -> Result<MonitoringSnapshot, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Monitoring state is unavailable.".to_owned())?;
        if let Some(machine) = inner.machine.as_mut() {
            machine.finalized();
        }
        if inner.snapshot.running {
            inner.snapshot.state = RecordingState::Monitoring;
            inner.snapshot.confirmation_elapsed_ms = 0;
            inner.snapshot.confirmation_target_ms = 0;
        }
        Ok(inner.snapshot.clone())
    }

    pub fn fail(&self, error: String) -> MonitoringSnapshot {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return MonitoringSnapshot {
                    state: RecordingState::Error,
                    last_error: Some(error),
                    ..MonitoringSnapshot::default()
                }
            }
        };
        if let Some(machine) = inner.machine.as_mut() {
            machine.fail();
        }
        inner.snapshot.running = false;
        inner.snapshot.state = RecordingState::Error;
        inner.snapshot.last_error = Some(error);
        inner.snapshot.clone()
    }

    pub fn stop(&self) -> Result<MonitoringSnapshot, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Monitoring state is unavailable.".to_owned())?;
        if let Some(machine) = inner.machine.as_mut() {
            machine.stop();
        }
        inner.machine = None;
        inner.started_at = None;
        inner.snapshot.running = false;
        inner.snapshot.state = RecordingState::Idle;
        inner.snapshot.confirmation_elapsed_ms = 0;
        inner.snapshot.confirmation_target_ms = 0;
        Ok(inner.snapshot.clone())
    }

    pub fn status(&self) -> MonitoringSnapshot {
        self.inner
            .lock()
            .map(|inner| inner.snapshot.clone())
            .unwrap_or_else(|_| MonitoringSnapshot {
                state: RecordingState::Error,
                last_error: Some("Monitoring status is unavailable.".to_owned()),
                ..MonitoringSnapshot::default()
            })
    }
}

fn update_snapshot(inner: &mut Inner, now: Duration) {
    let Some(machine) = inner.machine.as_ref() else {
        return;
    };
    let (elapsed, target) = machine.confirmation_timing(now);
    inner.snapshot.state = machine.state();
    inner.snapshot.confirmation_elapsed_ms = elapsed.as_millis() as u64;
    inner.snapshot.confirmation_target_ms = match machine.state() {
        RecordingState::StartConfirming => inner.start_confirmation_ms,
        RecordingState::StopConfirming => inner.stop_confirmation_ms,
        _ => target.as_millis() as u64,
    };
    inner.snapshot.last_error = None;
}

fn validate_request(request: &StartMonitoringRequest) -> Result<(), String> {
    // Rust accepts the broader safety envelope used by persisted settings and
    // state-machine tests. RECORDING_SETTING_LIMITS in the frontend protocol
    // deliberately exposes a narrower, product-oriented range.
    if !(200..=1_000).contains(&request.analysis_interval_ms) {
        return Err("The analysis interval must be between 200 and 1000 ms.".to_owned());
    }
    if !(100..=60_000).contains(&request.start_confirmation_ms) {
        return Err("The start confirmation must be between 100 ms and 60 seconds.".to_owned());
    }
    if !(500..=300_000).contains(&request.stop_confirmation_ms) {
        return Err("The stop confirmation must be between 500 ms and 5 minutes.".to_owned());
    }
    if request.pre_roll_ms > 30_000 {
        return Err("Pre-roll must be between 0 and 30 seconds.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn request() -> StartMonitoringRequest {
        StartMonitoringRequest {
            start_confirmation_ms: 100,
            stop_confirmation_ms: 500,
            pre_roll_ms: 5_000,
            analysis_interval_ms: 300,
        }
    }

    #[test]
    fn confirmed_observation_requests_recording_without_owning_a_device() {
        let manager = MonitoringManager::default();
        manager.start(request()).unwrap();
        assert_eq!(manager.observe(true).unwrap().action, CaptureAction::None);
        thread::sleep(Duration::from_millis(110));
        assert_eq!(
            manager.observe(true).unwrap().action,
            CaptureAction::StartRecording
        );
    }

    #[test]
    fn manual_cycle_returns_to_monitoring() {
        let manager = MonitoringManager::default();
        manager.start(request()).unwrap();
        assert_eq!(
            manager.manual_start().unwrap().action,
            CaptureAction::StartRecording
        );
        manager.recording_started().unwrap();
        assert_eq!(
            manager.manual_stop().unwrap().action,
            CaptureAction::StopRecording
        );
        assert_eq!(
            manager.recording_finalized().unwrap().state,
            RecordingState::Monitoring
        );
    }

    #[test]
    fn monitoring_allows_pre_roll_to_be_disabled() {
        let manager = MonitoringManager::default();
        let mut request = request();
        request.pre_roll_ms = 0;
        assert!(manager.start(request).is_ok());
    }
}
