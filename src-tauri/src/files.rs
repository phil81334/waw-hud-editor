use std::{fs, path::PathBuf};

pub fn read_project(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
        != "wawhud"
    {
        return Err("Choose a .wawhud project.".into());
    }
    if fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len()
        > 4 * 1024 * 1024
    {
        return Err("Project is too large (maximum 4 MB).".into());
    }
    fs::read_to_string(path).map_err(|error| error.to_string())
}

pub fn write_document(path: String, contents: String, mode: String) -> Result<(), String> {
    use std::io::Write;
    let path = PathBuf::from(path);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["inc", "wawhud"].contains(&extension.as_str()) || contents.len() > 4 * 1024 * 1024 {
        return Err("Save a .wawhud project or .inc HUD (maximum 4 MB).".into());
    }
    if !["new", "replace", "backup"].contains(&mode.as_str()) {
        return Err("Unknown overwrite choice.".into());
    }
    if mode == "new" && path.exists() {
        return Err("EXISTS".into());
    }
    let folder = path.parent().ok_or("Choose a save folder.")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(folder).map_err(|error| error.to_string())?;
    temporary
        .write_all(contents.as_bytes())
        .map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    if mode == "backup" && path.exists() {
        let mut index = 1;
        loop {
            let backup = path.with_file_name(format!(
                "{}.backup-{index}",
                path.file_name().unwrap().to_string_lossy()
            ));
            if backup.exists() {
                index += 1;
                continue;
            }
            let mut old = fs::File::open(&path).map_err(|error| error.to_string())?;
            let mut copy =
                tempfile::NamedTempFile::new_in(folder).map_err(|error| error.to_string())?;
            std::io::copy(&mut old, &mut copy).map_err(|error| error.to_string())?;
            copy.as_file()
                .sync_all()
                .map_err(|error| error.to_string())?;
            // Publish only a complete backup; never leave an empty placeholder
            // if copying fails. A concurrent writer cannot be overwritten.
            copy.persist_noclobber(&backup)
                .map_err(|error| error.to_string())?;
            break;
        }
    }
    if mode == "new" {
        temporary
            .persist_noclobber(&path)
            .map_err(|error| error.to_string())?;
    } else {
        temporary
            .persist(&path)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
