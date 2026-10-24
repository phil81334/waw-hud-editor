//! A manual-refresh catalogue. JSON stores metadata, never image pixels.
use crate::assets::{logical, Assets, Catalogue, Font, Material, Source};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

// Increment when stored metadata or supported-material rules change.
const VERSION: u32 = 1;
const CACHE_LIMIT: u64 = 16 * 1024 * 1024;
pub(crate) const PROFILE_FILES: [&str; 3] = [
    "raw/techsets/2d.techset",
    "raw/techniques/vertcol_simple2d.tech",
    "raw/statemaps/default2d.sm",
];

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct Stamp {
    bytes: u64,
    modified: Option<(u64, u32)>,
    is_file: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct FileRecord {
    stamp: Option<Stamp>,
    error: Option<String>,
}

fn stamp(path: &Path) -> Result<Option<Stamp>, String> {
    match fs::metadata(path) {
        Ok(metadata) => {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| (time.as_secs(), time.subsec_nanos()));
            Ok(Some(Stamp {
                bytes: metadata.len(),
                modified,
                is_file: metadata.is_file(),
            }))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct SavedCache {
    version: u32,
    root: PathBuf,
    entries: HashMap<String, Source>,
    pub(crate) catalogue: Catalogue,
    pub(crate) materials: BTreeMap<String, Material>,
    pub(crate) fonts: Vec<Font>,
    sources: BTreeMap<String, Vec<String>>,
    files: BTreeMap<String, FileRecord>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub mode: String,
    pub path: String,
    pub warning: String,
    pub issues: BTreeMap<String, String>,
    pub font_names: Vec<String>,
}

#[derive(Serialize)]
pub struct CachedCatalogue {
    #[serde(flatten)]
    pub catalogue: Catalogue,
    pub cache: CacheInfo,
}

fn identity(root: &Path) -> Result<String, String> {
    fs::canonicalize(root)
        .map(|path| path.to_string_lossy().to_lowercase())
        .map_err(|error| error.to_string())
}

/// Each installation has its own small file in the user's local cache folder.
pub fn location(root: &Path) -> Result<PathBuf, String> {
    let local =
        std::env::var_os("LOCALAPPDATA").ok_or("Windows local data folder is unavailable.")?;
    let key = format!("{:x}", Sha256::digest(identity(root)?.as_bytes()));
    Ok(PathBuf::from(local)
        .join("WaW HUD Editor")
        .join("cache")
        .join(format!("catalogue-{}.json", &key[..16])))
}

fn validate(data: &SavedCache, root: &Path) -> Result<(), String> {
    if data.version != VERSION || identity(&data.root)? != identity(root)? {
        return Err(
            "This saved catalogue is for another app format or installation. Click Rescan.".into(),
        );
    }
    if data.entries.len() > 100_000
        || data.materials.len() > 100_000
        || data.files.len() > 100_000
        || data.fonts.len() > 7
    {
        return Err(
            "The saved catalogue exceeds the supported metadata limits. Click Rescan.".into(),
        );
    }
    for (name, source) in &data.entries {
        logical(name)?;
        let filename = source
            .archive
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid cached archive name.")?;
        let lower = filename.to_lowercase();
        if source.archive.parent() != Some(data.root.join("main").as_path())
            || !lower.ends_with(".iwd")
            || !(lower.starts_with("iw_") || lower.starts_with("localized_english_iw"))
            || source.entry.replace('\\', "/").to_lowercase() != *name
            || !(name.starts_with("images/") || name.starts_with("materials/"))
        {
            return Err("Invalid archive lookup in the saved catalogue. Click Rescan.".into());
        }
    }
    for name in data.files.keys() {
        logical(name)?;
        if !(name.starts_with("raw/")
            || (name.starts_with("main/") && name.split('/').count() == 2))
        {
            return Err("Invalid source path in the saved catalogue. Click Rescan.".into());
        }
    }
    for (name, paths) in &data.sources {
        logical(name)?;
        if paths.len() > 2 || paths.iter().any(|path| !data.files.contains_key(path)) {
            return Err("Invalid source references in the saved catalogue. Click Rescan.".into());
        }
    }
    for (name, material) in &data.materials {
        logical(name)?;
        logical(&material.image)?;
        if !material.levels.is_empty() || !data.sources.contains_key(&format!("materials/{name}")) {
            return Err("Invalid material metadata in the saved catalogue. Click Rescan.".into());
        }
    }
    for name in &data.catalogue.names {
        logical(name)?;
        if !data.materials.contains_key(&name.to_lowercase()) {
            return Err("Missing material metadata in the saved catalogue. Click Rescan.".into());
        }
    }
    for font in &data.fonts {
        logical(&font.name)?;
        if !data
            .files
            .contains_key(&format!("raw/english/fonts/{}", font.name))
        {
            return Err("Missing font metadata in the saved catalogue. Click Rescan.".into());
        }
    }
    for name in PROFILE_FILES {
        if !data.files.contains_key(name) {
            return Err("Missing 2D profile metadata in the saved catalogue. Click Rescan.".into());
        }
    }
    Ok(())
}

/// Restoring JSON does not enumerate main/raw or validate all recorded files.
pub fn open(root: PathBuf, path: &Path) -> Result<Assets, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Assets::new(root),
        Err(error) => {
            return Err(format!(
                "Cannot read the asset cache: {error}. Click Rescan."
            ))
        }
    };
    let mut bytes = Vec::new();
    file.take(CACHE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > CACHE_LIMIT {
        return Err("The asset cache is too large. Click Rescan.".into());
    }
    let data: SavedCache = serde_json::from_slice(&bytes)
        .map_err(|_| "The asset cache could not be read. Click Rescan to replace it.")?;
    validate(&data, &root)?;
    Ok(Assets {
        root,
        entries: data.entries.clone(),
        readers: Mutex::new(HashMap::new()),
        cache: Some(data),
        cache_origin: "saved",
        cache_issues: Mutex::new(BTreeMap::new()),
    })
}

impl SavedCache {
    fn remember(&mut self, root: &Path, path: &str) {
        if !self.files.contains_key(path) {
            let record = match stamp(&root.join(path)) {
                Ok(stamp) => FileRecord { stamp, error: None },
                Err(error) => FileRecord {
                    stamp: None,
                    error: Some(error),
                },
            };
            self.files.insert(path.to_string(), record);
        }
    }

    fn source(&mut self, assets: &Assets, name: &str) -> Result<(), String> {
        logical(name)?;
        let paths = if let Some(source) = assets.entries.get(&name.to_lowercase()) {
            vec![format!(
                "main/{}",
                source
                    .archive
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("Invalid archive filename.")?
            )]
        } else {
            vec![format!("raw/{name}"), format!("raw/english/{name}")]
        };
        for path in &paths {
            self.remember(&assets.root, path);
        }
        self.sources.insert(name.to_lowercase(), paths);
        Ok(())
    }
}

pub fn catalogue(assets: &mut Assets, path: &Path) -> Result<CachedCatalogue, String> {
    if assets.cache_origin == "cleared" {
        return Err("Cache cleared. Click Rescan to load assets again.".into());
    }
    let mut warning = String::new();
    if assets.cache.is_none() {
        let (catalogue, materials) = assets.scan_profiles()?;
        let fonts = assets.fonts()?;
        let mut data = SavedCache {
            version: VERSION,
            root: assets.root.clone(),
            entries: assets.entries.clone(),
            catalogue,
            materials: BTreeMap::new(),
            fonts,
            sources: BTreeMap::new(),
            files: BTreeMap::new(),
        };
        data.entries.retain(|name, _| logical(name).is_ok());
        for material in materials {
            data.materials
                .insert(material.name.to_lowercase(), material);
        }
        for font in &data.fonts {
            if !data.materials.contains_key(&font.material.to_lowercase()) {
                data.materials.insert(
                    font.material.to_lowercase(),
                    assets.material_profile(&font.material)?,
                );
            }
        }
        let references: Vec<(String, String)> = data
            .materials
            .values()
            .map(|material| (material.name.clone(), material.image.clone()))
            .collect();
        for (name, image) in references {
            data.source(assets, &format!("materials/{name}"))?;
            data.source(assets, &format!("images/{image}.iwi"))?;
        }
        // Retain archive stamps for every saved lookup, not their contents.
        let archives: Vec<PathBuf> = data
            .entries
            .values()
            .map(|entry| entry.archive.clone())
            .collect();
        for archive in archives {
            data.remember(
                &assets.root,
                &format!("main/{}", archive.file_name().unwrap().to_string_lossy()),
            );
        }
        for name in PROFILE_FILES {
            data.remember(&assets.root, name);
        }
        let font_names: Vec<String> = data.fonts.iter().map(|font| font.name.clone()).collect();
        for name in font_names {
            data.remember(&assets.root, &format!("raw/english/fonts/{name}"));
        }
        let save = (|| -> Result<(), String> {
            let parent = path.parent().ok_or("Invalid cache folder.")?;
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            let mut file =
                tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
            // Buffer JSON so its tokens do not each become a small disk write.
            let bytes = serde_json::to_vec(&data).map_err(|error| error.to_string())?;
            if bytes.len() as u64 > CACHE_LIMIT {
                return Err("The catalogue is too large for the saved metadata limit.".into());
            }
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            file.flush().map_err(|error| error.to_string())?;
            file.as_file()
                .sync_all()
                .map_err(|error| error.to_string())?;
            file.persist(path).map_err(|error| error.to_string())?;
            Ok(())
        })();
        if let Err(error) = save {
            warning =
                format!("Catalogue is available for this session but could not be saved: {error}");
            assets.cache_origin = "session";
        } else {
            assets.cache_origin = "scanned";
        }
        assets.cache = Some(data);
    }
    let cache = assets
        .cache
        .as_ref()
        .ok_or("The asset cache is unavailable.")?;
    Ok(CachedCatalogue {
        catalogue: cache.catalogue.clone(),
        cache: CacheInfo {
            mode: assets.cache_origin.to_string(),
            path: path.to_string_lossy().into(),
            warning,
            font_names: cache.fonts.iter().map(|font| font.name.clone()).collect(),
            issues: assets
                .cache_issues
                .lock()
                .map_err(|_| "Unavailable cache status.")?
                .clone(),
        },
    })
}

/// Clearing the saved file does not discard textures already used by a HUD.
pub fn clear(assets: &mut Assets, path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Could not clear the asset cache: {error}")),
    }
    assets.cache_origin = "cleared";
    Ok(())
}

impl Assets {
    pub(crate) fn check_cached_file(&self, relative: &str) -> Result<(), String> {
        let Some(cache) = &self.cache else {
            return Ok(());
        };
        let expected = cache
            .files
            .get(relative)
            .ok_or("This source is not in the saved catalogue. Click Rescan.")?;
        let current = stamp(&self.root.join(relative));
        if expected.error.is_some() || current.as_ref().ok() != Some(&expected.stamp) {
            return Err(format!(
                "Changed or unavailable since the last scan: {relative}. Click Rescan."
            ));
        }
        Ok(())
    }

    pub(crate) fn check_cached_source(&self, name: &str) -> Result<(), String> {
        let Some(cache) = &self.cache else {
            return Ok(());
        };
        let key = name.to_lowercase();
        if let Some(source) = self.entries.get(&key) {
            let path = format!(
                "main/{}",
                source.archive.file_name().unwrap().to_string_lossy()
            );
            return self.check_cached_file(&path);
        }
        let paths = cache
            .sources
            .get(&key)
            .ok_or("This asset is not in the saved catalogue. Click Rescan.")?;
        for path in paths {
            self.check_cached_file(path)?;
        }
        Ok(())
    }
}
