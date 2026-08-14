use super::RecordingState;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutomationAction {
    None,
    StartRecording,
    StopRecording,
}

#[derive(Debug)]
pub struct AutomationStateMachine {
    state: RecordingState,
    candidate_since: Option<Duration>,
    start_confirmation: Duration,
    stop_confirmation: Duration,
}

impl AutomationStateMachine {
    pub fn new(start_confirmation: Duration, stop_confirmation: Duration) -> Self {
        Self {
            state: RecordingState::Monitoring,
            candidate_since: None,
            start_confirmation,
            stop_confirmation,
        }
    }

    pub fn state(&self) -> RecordingState {
        self.state
    }

    pub fn confirmation_timing(&self, now: Duration) -> (Duration, Duration) {
        let elapsed = self
            .candidate_since
            .map_or(Duration::ZERO, |started| now.saturating_sub(started));
        let target = match self.state {
            RecordingState::StartConfirming => self.start_confirmation,
            RecordingState::StopConfirming => self.stop_confirmation,
            _ => Duration::ZERO,
        };
        (elapsed, target)
    }

    pub fn observe(&mut self, content_active: bool, now: Duration) -> AutomationAction {
        match self.state {
            RecordingState::Monitoring if content_active => {
                self.state = RecordingState::StartConfirming;
                self.candidate_since = Some(now);
            }
            RecordingState::StartConfirming if !content_active => {
                self.state = RecordingState::Monitoring;
                self.candidate_since = None;
            }
            RecordingState::StartConfirming if self.confirmed_for(now, self.start_confirmation) => {
                self.state = RecordingState::Recording;
                self.candidate_since = None;
                return AutomationAction::StartRecording;
            }
            RecordingState::Recording if !content_active => {
                self.state = RecordingState::StopConfirming;
                self.candidate_since = Some(now);
            }
            RecordingState::StopConfirming if content_active => {
                self.state = RecordingState::Recording;
                self.candidate_since = None;
            }
            RecordingState::StopConfirming if self.confirmed_for(now, self.stop_confirmation) => {
                self.state = RecordingState::Finalizing;
                self.candidate_since = None;
                return AutomationAction::StopRecording;
            }
            _ => {}
        }
        AutomationAction::None
    }

    pub fn force_recording(&mut self) {
        self.state = RecordingState::Recording;
        self.candidate_since = None;
    }

    pub fn begin_finalizing(&mut self) {
        self.state = RecordingState::Finalizing;
        self.candidate_since = None;
    }

    pub fn finalized(&mut self) {
        self.state = RecordingState::Monitoring;
        self.candidate_since = None;
    }

    pub fn stop(&mut self) {
        self.state = RecordingState::Idle;
        self.candidate_since = None;
    }

    pub fn fail(&mut self) {
        self.state = RecordingState::Error;
        self.candidate_since = None;
    }

    fn confirmed_for(&self, now: Duration, required: Duration) -> bool {
        self.candidate_since
            .is_some_and(|started| now.saturating_sub(started) >= required)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seconds(value: u64) -> Duration {
        Duration::from_secs(value)
    }

    #[test]
    fn short_active_candidate_does_not_start_recording() {
        let mut machine = AutomationStateMachine::new(seconds(2), seconds(10));
        assert_eq!(machine.observe(true, seconds(5)), AutomationAction::None);
        assert_eq!(machine.state(), RecordingState::StartConfirming);
        assert_eq!(machine.observe(false, seconds(6)), AutomationAction::None);
        assert_eq!(machine.state(), RecordingState::Monitoring);
    }

    #[test]
    fn confirmed_active_candidate_starts_recording() {
        let mut machine = AutomationStateMachine::new(seconds(2), seconds(10));
        machine.observe(true, seconds(5));
        assert_eq!(
            machine.observe(true, seconds(7)),
            AutomationAction::StartRecording
        );
        assert_eq!(machine.state(), RecordingState::Recording);
    }

    #[test]
    fn short_inactive_candidate_returns_to_recording() {
        let mut machine = AutomationStateMachine::new(seconds(2), seconds(10));
        machine.force_recording();
        machine.observe(false, seconds(10));
        assert_eq!(machine.state(), RecordingState::StopConfirming);
        assert_eq!(machine.observe(true, seconds(13)), AutomationAction::None);
        assert_eq!(machine.state(), RecordingState::Recording);
    }

    #[test]
    fn confirmed_inactive_candidate_requests_finalization() {
        let mut machine = AutomationStateMachine::new(seconds(2), seconds(10));
        machine.force_recording();
        machine.observe(false, seconds(10));
        assert_eq!(
            machine.observe(false, seconds(20)),
            AutomationAction::StopRecording
        );
        assert_eq!(machine.state(), RecordingState::Finalizing);
        machine.finalized();
        assert_eq!(machine.state(), RecordingState::Monitoring);
    }

    #[test]
    fn manual_stop_enters_finalizing_and_failure_enters_error() {
        let mut machine = AutomationStateMachine::new(seconds(2), seconds(10));
        machine.force_recording();
        machine.begin_finalizing();
        assert_eq!(machine.state(), RecordingState::Finalizing);
        machine.fail();
        assert_eq!(machine.state(), RecordingState::Error);
    }

    #[test]
    fn sample_sequence_creates_two_files_and_keeps_short_gap() {
        let mut machine = AutomationStateMachine::new(seconds(2), seconds(10));
        let mut starts = 0;
        let mut stops = 0;
        let samples = [
            (0, false),
            (5, true),
            (7, true),
            (35, false),
            (38, true),
            (58, false),
            (68, false),
            (73, true),
            (75, true),
            (83, false),
            (93, false),
        ];
        for (time, active) in samples {
            match machine.observe(active, seconds(time)) {
                AutomationAction::StartRecording => starts += 1,
                AutomationAction::StopRecording => {
                    stops += 1;
                    machine.finalized();
                }
                AutomationAction::None => {}
            }
        }
        assert_eq!((starts, stops), (2, 2));
        assert_eq!(machine.state(), RecordingState::Monitoring);
    }
}
