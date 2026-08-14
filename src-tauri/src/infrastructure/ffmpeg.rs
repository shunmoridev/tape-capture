use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static BUNDLED_FFMPEG: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub available: bool,
    pub version: Option<String>,
    pub source: Option<String>,
    pub error: Option<String>,
}

pub fn set_bundled_path(path: Option<PathBuf>) {
    if let Some(path) = path {
        let _ = BUNDLED_FFMPEG.set(path);
    }
}

pub fn binary() -> (PathBuf, &'static str) {
    if let Some(path) = std::env::var_os("TAPECAPTURE_FFMPEG_PATH") {
        return (PathBuf::from(path), "environment");
    }
    if let Some(path) = BUNDLED_FFMPEG.get() {
        return (path.clone(), "bundled");
    }
    (PathBuf::from("ffmpeg"), "PATH")
}

pub fn command() -> Command {
    let (binary, _) = binary();
    let mut command = Command::new(binary);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub fn status() -> FfmpegStatus {
    let (_, source) = binary();
    match command()
        .arg("-version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .map(str::to_owned);
            FfmpegStatus {
                available: true,
                version,
                source: Some(source.to_owned()),
                error: None,
            }
        }
        Ok(output) => FfmpegStatus {
            available: false,
            version: None,
            source: Some(source.to_owned()),
            error: Some(format!("FFmpeg exited with status {}.", output.status)),
        },
        Err(error) => FfmpegStatus {
            available: false,
            version: None,
            source: Some(source.to_owned()),
            error: Some(format!(
                "FFmpeg was not found. Install it on PATH or set TAPECAPTURE_FFMPEG_PATH. ({error})"
            )),
        },
    }
}
