mod automation;
mod manager;
mod state;

pub use automation::{AutomationAction, AutomationStateMachine};
pub use manager::{
    BeginRecordingResponse, RecordingManager, RecordingSnapshot, StartRecordingRequest,
};
pub use state::RecordingState;
