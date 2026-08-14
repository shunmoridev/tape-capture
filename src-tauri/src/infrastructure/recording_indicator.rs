use tauri::{AppHandle, Manager};

pub fn set(app: &AppHandle, active: bool) {
    let Some(window) = app
        .get_window("main")
        .or_else(|| app.windows().into_values().next())
    else {
        eprintln!("Recording indicator: no native application window is available.");
        return;
    };

    #[cfg(target_os = "windows")]
    {
        let overlay = active.then(recording_overlay_icon);
        if let Err(error) = window.set_overlay_icon(overlay) {
            eprintln!("Recording indicator: could not update the taskbar overlay: {error}");
        }
    }

    #[cfg(target_os = "macos")]
    {
        let label = active.then(|| "●".to_owned());
        if let Err(error) = window.set_badge_label(label) {
            eprintln!("Recording indicator: could not update the Dock badge: {error}");
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Err(error) = window.set_badge_count(active.then_some(1)) {
            eprintln!("Recording indicator: could not update the taskbar badge: {error}");
        }
    }
}

#[cfg(target_os = "windows")]
fn recording_overlay_icon() -> tauri::image::Image<'static> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0_u8; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as i32 - 16;
            let dy = y as i32 - 16;
            let distance_squared = dx * dx + dy * dy;
            let color = if distance_squared <= 10 * 10 {
                [229, 57, 53, 255]
            } else if distance_squared <= 13 * 13 {
                [255, 255, 255, 255]
            } else {
                [0, 0, 0, 0]
            };
            let offset = ((y * SIZE + x) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&color);
        }
    }

    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}
