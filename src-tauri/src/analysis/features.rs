use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameFeatures {
    pub average_luma: f64,
    pub luma_variance: f64,
    pub color_variance: f64,
    pub dominant_color_ratio: f64,
    pub frame_difference: f64,
    pub edge_energy: f64,
    pub information_entropy: f64,
    pub audio_rms_db: Option<f64>,
    pub inactive_candidate: bool,
}

pub fn analyze_rgb_frame(
    frame: &[u8],
    width: usize,
    height: usize,
    previous: Option<&[u8]>,
    audio_rms_db: Option<f64>,
) -> Result<FrameFeatures, String> {
    let pixel_count = width
        .checked_mul(height)
        .ok_or_else(|| "Analysis frame dimensions overflowed.".to_owned())?;
    if frame.len() != pixel_count * 3 {
        return Err(format!(
            "Expected {} RGB bytes, received {}.",
            pixel_count * 3,
            frame.len()
        ));
    }
    if previous.is_some_and(|value| value.len() != frame.len()) {
        return Err("The previous analysis frame has a different size.".to_owned());
    }

    let mut channel_sum = [0.0_f64; 3];
    let mut channel_square_sum = [0.0_f64; 3];
    let mut luma_sum = 0.0_f64;
    let mut luma_square_sum = 0.0_f64;
    let mut luma_values = Vec::with_capacity(pixel_count);
    let mut luma_histogram = [0_u32; 256];
    let mut color_histogram = [0_u32; 4096];
    let mut coarse_color_histogram = [0_u32; 512];

    for pixel in frame.chunks_exact(3) {
        let red = f64::from(pixel[0]);
        let green = f64::from(pixel[1]);
        let blue = f64::from(pixel[2]);
        for (index, value) in [red, green, blue].into_iter().enumerate() {
            channel_sum[index] += value;
            channel_square_sum[index] += value * value;
        }
        let luma = (0.2126 * red + 0.7152 * green + 0.0722 * blue)
            .round()
            .clamp(0.0, 255.0) as u8;
        luma_sum += f64::from(luma);
        luma_square_sum += f64::from(luma) * f64::from(luma);
        luma_values.push(luma);
        luma_histogram[usize::from(luma)] += 1;
        let color_bin = (usize::from(pixel[0] >> 4) << 8)
            | (usize::from(pixel[1] >> 4) << 4)
            | usize::from(pixel[2] >> 4);
        color_histogram[color_bin] += 1;
        let coarse_color_bin = (usize::from(pixel[0] >> 5) << 6)
            | (usize::from(pixel[1] >> 5) << 3)
            | usize::from(pixel[2] >> 5);
        coarse_color_histogram[coarse_color_bin] += 1;
    }

    let count = pixel_count as f64;
    let average_luma = luma_sum / count;
    let luma_variance = non_negative_variance(luma_sum, luma_square_sum, count);
    let color_variance = (0..3)
        .map(|index| non_negative_variance(channel_sum[index], channel_square_sum[index], count))
        .sum::<f64>()
        / 3.0;
    let dominant_color_ratio = f64::from(color_histogram.into_iter().max().unwrap_or(0)) / count;
    let coarse_dominant_color_ratio =
        f64::from(coarse_color_histogram.into_iter().max().unwrap_or(0)) / count;
    let frame_difference = previous.map_or(0.0, |previous| {
        frame
            .iter()
            .zip(previous)
            .map(|(current, old)| current.abs_diff(*old) as f64)
            .sum::<f64>()
            / (frame.len() as f64 * 255.0)
    });
    let edge_energy = calculate_edge_energy(&luma_values, width, height);
    let information_entropy = luma_histogram
        .into_iter()
        .filter(|count| *count > 0)
        .map(|bin_count| {
            let probability = f64::from(bin_count) / count;
            -probability * probability.log2()
        })
        .sum();

    let average_red = channel_sum[0] / count;
    let average_green = channel_sum[1] / count;
    let average_blue = channel_sum[2] / count;
    let visually_flat = dominant_color_ratio >= 0.72
        || (color_variance < 180.0 && luma_variance < 140.0 && edge_energy < 0.035);
    let low_motion = frame_difference < 0.018;
    let low_audio = audio_rms_db.unwrap_or(-100.0) < -48.0;
    // Capture devices commonly output a noisy blue field (sometimes with a
    // small OSD) while no tape picture is present. The analogue audio input can
    // still contain hiss well above the silence threshold, so this distinctive
    // device signal must not depend on audio RMS alone.
    let blue_device_screen = average_blue >= 80.0
        && average_blue - average_red >= 45.0
        && average_blue - average_green >= 30.0
        && edge_energy < 0.085
        && (coarse_dominant_color_ratio >= 0.35 || color_variance < 900.0);
    let black_device_screen =
        average_luma < 18.0 && color_variance < 160.0 && edge_energy < 0.025 && low_audio;
    let inactive_candidate =
        low_motion && (blue_device_screen || black_device_screen || (visually_flat && low_audio));

    Ok(FrameFeatures {
        average_luma,
        luma_variance,
        color_variance,
        dominant_color_ratio,
        frame_difference,
        edge_energy,
        information_entropy,
        audio_rms_db,
        inactive_candidate,
    })
}

pub fn analyze_rgba_frame(
    frame: &[u8],
    width: usize,
    height: usize,
    previous_rgb: Option<&[u8]>,
    audio_rms_db: Option<f64>,
) -> Result<(FrameFeatures, Vec<u8>), String> {
    let pixel_count = width
        .checked_mul(height)
        .ok_or_else(|| "Analysis frame dimensions overflowed.".to_owned())?;
    if frame.len() != pixel_count * 4 {
        return Err(format!(
            "Expected {} RGBA bytes, received {}.",
            pixel_count * 4,
            frame.len()
        ));
    }
    let mut rgb = Vec::with_capacity(pixel_count * 3);
    for pixel in frame.chunks_exact(4) {
        rgb.extend_from_slice(&pixel[..3]);
    }
    let features = analyze_rgb_frame(&rgb, width, height, previous_rgb, audio_rms_db)?;
    Ok((features, rgb))
}

fn non_negative_variance(sum: f64, square_sum: f64, count: f64) -> f64 {
    (square_sum / count - (sum / count).powi(2)).max(0.0)
}

fn calculate_edge_energy(luma: &[u8], width: usize, height: usize) -> f64 {
    if width < 2 || height < 2 {
        return 0.0;
    }
    let mut total = 0.0_f64;
    let mut comparisons = 0_usize;
    for y in 0..height - 1 {
        for x in 0..width - 1 {
            let index = y * width + x;
            total += f64::from(luma[index].abs_diff(luma[index + 1]));
            total += f64::from(luma[index].abs_diff(luma[index + width]));
            comparisons += 2;
        }
    }
    total / (comparisons as f64 * 255.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solid_quiet_frame_is_inactive() {
        let frame = [20_u8, 70, 210].repeat(16);
        let features = analyze_rgb_frame(&frame, 4, 4, None, Some(-70.0)).unwrap();
        assert!(features.inactive_candidate);
        assert_eq!(features.dominant_color_ratio, 1.0);
        assert_eq!(features.frame_difference, 0.0);
    }

    #[test]
    fn textured_frame_is_active_even_when_quiet() {
        let mut frame = Vec::new();
        for index in 0..16 {
            let value = if index % 2 == 0 { 0 } else { 255 };
            frame.extend([value, 255 - value, value]);
        }
        let features = analyze_rgb_frame(&frame, 4, 4, None, Some(-70.0)).unwrap();
        assert!(!features.inactive_candidate);
        assert!(features.edge_energy > 0.2);
    }

    #[test]
    fn audible_solid_frame_stays_active() {
        let frame = [0_u8, 0, 0].repeat(16);
        let features = analyze_rgb_frame(&frame, 4, 4, None, Some(-20.0)).unwrap();
        assert!(!features.inactive_candidate);
    }

    #[test]
    fn noisy_audible_blue_device_screen_is_inactive() {
        let mut frame = Vec::new();
        for index in 0..64 {
            let red_noise = ((index * 7) % 29) as u8;
            let green_noise = ((index * 11) % 31) as u8;
            let blue_noise = ((index * 13) % 37) as u8;
            frame.extend([8 + red_noise, 30 + green_noise, 170 + blue_noise]);
        }
        let previous = frame.clone();
        let features = analyze_rgb_frame(&frame, 8, 8, Some(&previous), Some(-27.0)).unwrap();
        assert!(features.inactive_candidate);
        assert!(features.dominant_color_ratio < 0.72);
    }

    #[test]
    fn textured_blue_content_stays_active() {
        let mut frame = Vec::new();
        for y in 0..8 {
            for x in 0..8 {
                if (x + y) % 2 == 0 {
                    frame.extend([5, 20, 210]);
                } else {
                    frame.extend([180, 220, 255]);
                }
            }
        }
        let previous = frame.clone();
        let features = analyze_rgb_frame(&frame, 8, 8, Some(&previous), Some(-70.0)).unwrap();
        assert!(!features.inactive_candidate);
        assert!(features.edge_energy > 0.2);
    }

    #[test]
    fn motion_is_normalized_between_zero_and_one() {
        let previous = [0_u8, 0, 0].repeat(4);
        let current = [255_u8, 255, 255].repeat(4);
        let features = analyze_rgb_frame(&current, 2, 2, Some(&previous), Some(-70.0)).unwrap();
        assert_eq!(features.frame_difference, 1.0);
        assert!(!features.inactive_candidate);
    }

    #[test]
    fn rgba_input_ignores_alpha_and_returns_rgb_history() {
        let rgba = [10_u8, 20, 30, 255].repeat(4);
        let (features, rgb) = analyze_rgba_frame(&rgba, 2, 2, None, Some(-70.0)).unwrap();
        assert_eq!(rgb, [10_u8, 20, 30].repeat(4));
        assert!(features.inactive_candidate);
    }
}
