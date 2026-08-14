use std::path::{Path, PathBuf};

pub fn available_bytes(path: &str) -> Result<u64, String> {
    if path.trim().is_empty() {
        return Err("Choose an output directory first.".to_owned());
    }
    let requested = PathBuf::from(path);
    let existing = nearest_existing_path(&requested)
        .ok_or_else(|| "The output directory has no accessible parent.".to_owned())?;
    fs2::available_space(existing)
        .map_err(|error| format!("Could not read available storage space: {error}"))
}

fn nearest_existing_path(path: &Path) -> Option<&Path> {
    path.ancestors().find(|candidate| candidate.exists())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_space_from_existing_parent() {
        let nested = std::env::temp_dir()
            .join("tapecapture-storage-test")
            .join("not-created");
        assert!(available_bytes(&nested.to_string_lossy()).unwrap() > 0);
    }
}
