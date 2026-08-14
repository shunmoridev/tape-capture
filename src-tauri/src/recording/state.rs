use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordingState {
    #[default]
    Idle,
    Monitoring,
    StartConfirming,
    Recording,
    StopConfirming,
    Finalizing,
    Error,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_state_is_idle() {
        assert_eq!(RecordingState::default(), RecordingState::Idle);
    }

    #[test]
    fn every_required_state_is_serializable() {
        let states = [
            RecordingState::Idle,
            RecordingState::Monitoring,
            RecordingState::StartConfirming,
            RecordingState::Recording,
            RecordingState::StopConfirming,
            RecordingState::Finalizing,
            RecordingState::Error,
        ];
        let json = serde_json::to_string(&states).unwrap();
        assert!(json.contains("startConfirming"));
        assert!(json.contains("finalizing"));
    }
}
