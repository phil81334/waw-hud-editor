#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use waw_hud_editor::assets::{Assets, Font, Material};

// The session restores saved metadata once. Only an explicit Rescan enumerates
// the installation again; exports and previews use the same source snapshot.
static INDEX: OnceLock<Mutex<Option<Assets>>> = OnceLock::new();

fn with_assets<T>(
    refresh: bool,
    work: impl FnOnce(&mut Assets) -> Result<T, String>,
) -> Result<T, String> {
    let mut index = INDEX
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "The asset index is unavailable. Reopen the editor.".to_string())?;
    if refresh {
        let mut replacement = Assets::new(game_root()?)?;
        let result = work(&mut replacement)?;
        *index = Some(replacement);
        return Ok(result);
    }
    if index.is_none() {
        let root = game_root()?;
        let path = waw_hud_editor::asset_cache::location(&root)?;
        *index = Some(waw_hud_editor::asset_cache::open(root, &path)?);
    }
    work(index.as_mut().unwrap())
}

fn game_root() -> Result<PathBuf, String> {
    let root = if cfg!(debug_assertions) {
        std::env::var_os("WAW_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.local/test-root")
            })
    } else {
        std::env::current_exe()
            .map_err(|error| error.to_string())?
            .parent()
            .ok_or("Cannot find the app folder.")?
            .to_path_buf()
    };
    if !root.join("CoDWaW.exe").is_file() {
        return Err("Put this executable in your World at War folder, beside CoDWaW.exe, then open it again.".into());
    }
    Ok(root)
}

#[derive(Serialize)]
struct Context {
    root: String,
    development: bool,
}

#[tauri::command]
fn startup() -> Result<Context, String> {
    let root = game_root()?;
    if !root.join("raw/materials").is_dir() || !root.join("raw/english/fonts").is_dir() {
        return Err("Install the WaW Modtools in this game folder first. The editor needs raw/materials and raw/english/fonts.".into());
    }
    Ok(Context {
        root: root.to_string_lossy().into(),
        development: cfg!(debug_assertions),
    })
}

#[tauri::command]
async fn load_fonts() -> Result<Vec<Font>, String> {
    tauri::async_runtime::spawn_blocking(|| with_assets(false, |assets| assets.fonts()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn load_material(name: Option<String>, path: Option<String>) -> Result<Material, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_assets(false, |assets| {
            let name = match (name, path) {
                (Some(name), _) => name,
                (_, Some(path)) => assets.selected_name(&PathBuf::from(path))?,
                _ => return Err("Choose a converted material first.".into()),
            };
            assets.material(&name)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn scan_materials(
    force: Option<bool>,
) -> Result<waw_hud_editor::asset_cache::CachedCatalogue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_assets(force.unwrap_or(false), |assets| {
            let path = waw_hud_editor::asset_cache::location(&assets.root)?;
            waw_hud_editor::asset_cache::catalogue(assets, &path)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clear_asset_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = waw_hud_editor::asset_cache::location(&game_root()?)?;
        let mut index = INDEX
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "The asset index is unavailable.")?;
        if let Some(assets) = index.as_mut() {
            waw_hud_editor::asset_cache::clear(assets, &path)
        } else {
            // A broken JSON file can be removed even if restoration failed.
            match std::fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn material_thumbnail(name: String) -> Result<Material, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_assets(false, |assets| assets.thumbnail(&name))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn read_project(path: String) -> Result<String, String> {
    waw_hud_editor::files::read_project(path)
}

#[tauri::command]
fn write_document(path: String, contents: String, mode: String) -> Result<(), String> {
    waw_hud_editor::files::write_document(path, contents, mode)
}

#[tauri::command]
fn list_mods() -> Result<Vec<String>, String> {
    waw_hud_editor::mod_export::mods(&game_root()?)
}

#[tauri::command]
async fn review_mod_export(
    request: waw_hud_editor::mod_export::Request,
    copy_images: Option<bool>,
) -> Result<waw_hud_editor::mod_export::Review, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_assets(false, |assets| {
            if copy_images.unwrap_or(true) {
                waw_hud_editor::mod_export::review(assets, &request)
            } else {
                waw_hud_editor::mod_export::review_setup(assets, &request)
            }
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn prepare_mod_export(
    request: waw_hud_editor::mod_export::Request,
    fingerprint: String,
    copy_images: Option<bool>,
) -> Result<waw_hud_editor::mod_export::Completed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_assets(false, |assets| {
            if copy_images.unwrap_or(true) {
                waw_hud_editor::mod_export::prepare(assets, &request, &fingerprint)
            } else {
                waw_hud_editor::mod_export::prepare_setup(assets, &request, &fingerprint)
            }
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn review_image_export(
    request: waw_hud_editor::mod_export::ImageRequest,
) -> Result<waw_hud_editor::mod_export::Review, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_assets(false, |assets| {
            waw_hud_editor::mod_export::review_images(assets, &request)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn prepare_image_export(
    request: waw_hud_editor::mod_export::ImageRequest,
    fingerprint: String,
) -> Result<waw_hud_editor::mod_export::Completed, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_assets(false, |assets| {
            waw_hud_editor::mod_export::prepare_images(assets, &request, &fingerprint)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn list_image_folder(path: String) -> Result<waw_hud_editor::local_images::Folder, String> {
    tauri::async_runtime::spawn_blocking(move || waw_hud_editor::local_images::folder(path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn read_local_image(
    path: String,
    thumbnail: Option<bool>,
) -> Result<waw_hud_editor::local_images::Picture, String> {
    tauri::async_runtime::spawn_blocking(move || {
        waw_hud_editor::local_images::read(path, thumbnail.unwrap_or(false))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn main() {
    let profile = tempfile::Builder::new()
        .prefix("waw-hud-ui-")
        .tempdir()
        .expect("Cannot create browser profile");
    let profile_path = profile.path().to_path_buf();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(profile_path)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup,
            load_fonts,
            load_material,
            scan_materials,
            clear_asset_cache,
            list_image_folder,
            read_local_image,
            material_thumbnail,
            read_project,
            write_document,
            list_mods,
            review_mod_export,
            prepare_mod_export,
            review_image_export,
            prepare_image_export
        ])
        .run(tauri::generate_context!())
        .expect("Cannot start WaW HUD Editor");
}
