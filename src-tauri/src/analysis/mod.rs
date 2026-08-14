mod features;

pub use features::{analyze_rgba_frame, FrameFeatures};

use std::sync::Mutex;

#[derive(Default)]
struct AnalysisHistory {
    previous_rgb: Option<Vec<u8>>,
    generation: u64,
}

#[derive(Default)]
pub struct AnalysisManager {
    history: Mutex<AnalysisHistory>,
}

impl AnalysisManager {
    pub fn analyze_rgba(
        &self,
        frame: &[u8],
        width: usize,
        height: usize,
        audio_rms_db: Option<f64>,
    ) -> Result<FrameFeatures, String> {
        let (previous, generation) = {
            let history = self
                .history
                .lock()
                .map_err(|_| "Analysis history is unavailable.".to_owned())?;
            (history.previous_rgb.clone(), history.generation)
        };
        let (features, rgb) =
            analyze_rgba_frame(frame, width, height, previous.as_deref(), audio_rms_db)?;
        let mut history = self
            .history
            .lock()
            .map_err(|_| "Analysis history is unavailable.".to_owned())?;
        if history.generation == generation {
            history.previous_rgb = Some(rgb);
        }
        Ok(features)
    }

    pub fn reset(&self) {
        if let Ok(mut history) = self.history.lock() {
            history.previous_rgb = None;
            history.generation = history.generation.wrapping_add(1);
        }
    }
}
