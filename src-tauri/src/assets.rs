use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Source {
    pub(crate) archive: PathBuf,
    pub(crate) entry: String,
}

pub struct Assets {
    pub root: PathBuf,
    pub(crate) entries: HashMap<String, Source>,
    pub(crate) readers: Mutex<HashMap<PathBuf, zip::ZipArchive<fs::File>>>,
    pub(crate) cache: Option<crate::asset_cache::SavedCache>,
    pub(crate) cache_origin: &'static str,
    pub(crate) cache_issues: Mutex<std::collections::BTreeMap<String, String>>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Mip {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    pub name: String,
    pub image: String,
    pub source: String,
    pub image_source: String,
    pub sampler: u32,
    pub blend: String,
    pub alpha_test: u8,
    pub cull: u8,
    pub levels: Vec<Mip>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Catalogue {
    pub names: Vec<String>,
    pub examined: usize,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Glyph {
    letter: u16,
    x: i8,
    y: i8,
    advance: u8,
    width: u8,
    height: u8,
    uv: [f32; 4],
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Font {
    pub name: String,
    pub height: u32,
    pub material: String,
    pub glyphs: Vec<Glyph>,
}

fn u32_at(data: &[u8], at: usize) -> Result<u32, String> {
    let bytes = data.get(at..at + 4).ok_or("Truncated asset record.")?;
    Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
}

fn string_at(data: &[u8], at: usize) -> Result<String, String> {
    let bytes = data
        .get(at..)
        .ok_or("Asset string offset is outside the file.")?;
    let end = bytes
        .iter()
        .position(|value| *value == 0)
        .ok_or("Unterminated asset name.")?;
    let text = std::str::from_utf8(&bytes[..end]).map_err(|_| "Invalid asset name encoding.")?;
    Ok(text.to_string())
}

pub fn logical(name: &str) -> Result<(), String> {
    if name.is_empty()
        || !name.is_ascii()
        || name.contains(['\\', ':', '"'])
        || name.starts_with('/')
        || name
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Invalid logical asset name.".into());
    }
    Ok(())
}

impl Assets {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        let mut archives = Vec::new();
        if let Ok(directory) = fs::read_dir(root.join("main")) {
            for entry in directory.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.ends_with(".iwd")
                    && (name.starts_with("iw_") || name.starts_with("localized_english_iw"))
                {
                    archives.push(entry.path());
                }
            }
        }
        // The original English build route searches normal archives before the
        // language archives, with newer archive names first within each group.
        archives.sort_by_key(|path| {
            let name = path.file_name().unwrap().to_string_lossy().to_lowercase();
            (name.starts_with("localized_"), std::cmp::Reverse(name))
        });
        let mut entries: HashMap<String, Source> = HashMap::new();
        let mut readers = HashMap::new();
        for archive in archives {
            let file = fs::File::open(&archive).map_err(|error| error.to_string())?;
            let mut zip = zip::ZipArchive::new(file)
                .map_err(|error| format!("{}: {error}", archive.display()))?;
            for index in 0..zip.len() {
                let entry = zip.by_index(index).map_err(|error| error.to_string())?;
                let name = entry.name().replace('\\', "/").to_lowercase();
                if name.starts_with("images/") || name.starts_with("materials/") {
                    // Keep only the first archive entry in the verified search order.
                    // Lower-priority copies cannot change the selected asset.
                    entries.entry(name).or_insert_with(|| Source {
                        archive: archive.clone(),
                        entry: entry.name().to_string(),
                    });
                }
            }
            readers.insert(archive, zip);
        }
        Ok(Self {
            root,
            entries,
            readers: Mutex::new(readers),
            cache: None,
            cache_origin: "new",
            cache_issues: Mutex::new(std::collections::BTreeMap::new()),
        })
    }

    pub fn read(&self, name: &str) -> Result<(Vec<u8>, String), String> {
        logical(name)?;
        self.check_cached_source(name)?;
        if let Some(entry) = self.entries.get(&name.to_lowercase()) {
            // IWDs own the paths they supply. Do not open loose copies or fall
            // through to them if the selected archive entry cannot be read.
            // A restored index opens only archives actually needed for previews.
            let mut readers = self
                .readers
                .lock()
                .map_err(|_| "The archive reader is unavailable. Rescan assets.")?;
            if !readers.contains_key(&entry.archive) {
                let file = fs::File::open(&entry.archive).map_err(|error| error.to_string())?;
                let archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
                readers.insert(entry.archive.clone(), archive);
            }
            let zip = readers
                .get_mut(&entry.archive)
                .ok_or("Missing archive reader.")?;
            let stream = zip
                .by_name(&entry.entry)
                .map_err(|error| error.to_string())?;
            if stream.size() > 64 * 1024 * 1024 {
                return Err("Asset exceeds the HUD preview's 64 MB input limit.".into());
            }
            let mut data = Vec::new();
            stream
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut data)
                .map_err(|error| error.to_string())?;
            return Ok((
                data,
                format!(
                    "{} / {}",
                    entry.archive.file_name().unwrap().to_string_lossy(),
                    entry.entry
                ),
            ));
        }

        // Only paths missing from every IWD reach the loose-file fallback.
        // Preserve the existing conflict check between the two raw locations.
        let mut candidates = Vec::new();
        for prefix in ["raw", "raw/english"] {
            let path = self.root.join(prefix).join(name);
            if path.is_file() {
                let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
                if metadata.len() > 64 * 1024 * 1024 {
                    return Err("Asset exceeds the HUD preview's 64 MB input limit.".into());
                }
                candidates.push((
                    fs::read(&path).map_err(|error| error.to_string())?,
                    format!("{prefix}/{name}"),
                ));
            }
        }
        let first = candidates
            .first()
            .ok_or_else(|| format!("Missing converted asset: {name}"))?;
        for candidate in candidates.iter().skip(1) {
            if candidate.0 != first.0 {
                return Err(format!("Conflicting copies of {name}: {} and {}. Resolve these in your Modtools installation, then Reload assets.", first.1, candidate.1));
            }
        }
        Ok(first.clone())
    }

    pub fn validate_profile(&self) -> Result<(), String> {
        if self.cache.is_some() {
            for path in crate::asset_cache::PROFILE_FILES {
                self.check_cached_file(path)?;
            }
            return Ok(());
        }
        let files = [
            (
                "raw/techsets/2d.techset",
                "e10f9d14afe23705bd259dc6eff97c2acaefb61b28156e414f58936a0d96b3ba",
            ),
            (
                "raw/techniques/vertcol_simple2d.tech",
                "169c671ed0ee1a57181bc0a91f456a2c821fee116fab2f6df5e3f7efe28b1b8b",
            ),
            (
                "raw/statemaps/default2d.sm",
                "e8ae262e5a491d0bc189b6787f47c6b941c87388413319758c9a7aa7f4c56d63",
            ),
        ];
        for (name, expected) in files {
            let data = fs::read(self.root.join(name))
                .map_err(|_| format!("Missing Modtools file: {name}"))?;
            if format!("{:x}", Sha256::digest(&data)) != expected {
                return Err(format!(
                    "Modified 2D technique: {name}. This shader profile has not been verified."
                ));
            }
        }
        Ok(())
    }

    pub fn material(&self, name: &str) -> Result<Material, String> {
        self.validate_profile()?;
        let mut material = self.material_profile(name)?;
        let (bytes, image_source) = self.read(&format!("images/{}.iwi", material.image))?;
        let header = crate::iwi::header(&bytes)?;
        if u64::from(header.width) * u64::from(header.height) * 16 / 3 > 32 * 1024 * 1024 {
            return Err("This image exceeds the 32 MB decoded HUD-image limit. Convert a smaller image for the HUD.".into());
        }
        if header.faces != 1 || ![1, 3, 4, 6, 8, 11, 12, 13].contains(&header.format) {
            return Err("This image kind/format is not in the verified 2D HUD profile.".into());
        }
        material.image_source = image_source;
        material.levels = crate::iwi::decode(&bytes)?
            .into_iter()
            .map(|level| Mip {
                width: level.width,
                height: level.height,
                pixels: level.faces.into_iter().next().unwrap(),
            })
            .collect();
        Ok(material)
    }

    // Read the material settings without decoding its image. The catalogue and
    // document loader deliberately share this validation rather than guessing
    // which assets are HUD materials from their filenames.
    pub(crate) fn material_profile(&self, name: &str) -> Result<Material, String> {
        logical(name)?;
        if let Some(cache) = &self.cache {
            self.check_cached_source(&format!("materials/{name}"))?;
            let mut material = cache
                .materials
                .get(&name.to_lowercase())
                .cloned()
                .ok_or("This material is not in the saved catalogue. Rescan to update it.")?;
            material.name = name.to_string();
            return Ok(material);
        }
        let (data, source) = self.read(&format!("materials/{name}"))?;
        if data.len() < 64 {
            return Err("Truncated converted material. Select a material from raw/materials, not an IWI or GDT.".into());
        }
        let family = string_at(&data, u32_at(&data, 52)? as usize)?;
        let count = u16::from_le_bytes(data[48..50].try_into().unwrap());
        if family != "2d" || count != 1 {
            return Err(format!("{name}: select a converted standard 2D material with one colour map (found {family})."));
        }
        let table = u32_at(&data, 56)? as usize;
        if table < 64
            || table
                .checked_add(12)
                .filter(|end| *end <= data.len())
                .is_none()
        {
            return Err("Material texture table is outside the file.".into());
        }
        if string_at(&data, u32_at(&data, table)? as usize)? != "colorMap" {
            return Err("The selected material does not use a standard colorMap.".into());
        }
        let sampler = u32_at(&data, table + 4)?;
        if !(1..=4).contains(&(sampler & 7)) || (sampler >> 3 & 3) > 2 {
            return Err("Unsupported material sampler settings.".into());
        }
        let image = string_at(&data, u32_at(&data, table + 8)? as usize)?;
        logical(&image)?;
        let state = u32_at(&data, 40)?;
        let cull = (state >> 14 & 3) as u8;
        // Stock font atlases use back-face culling. HUD quads are front-facing;
        // this and None are equivalent for our fixed, unrotated 2D geometry.
        if cull != 1 && cull != 2 {
            return Err("This material uses unsupported front-face culling.".into());
        }
        let blend = match (state & 15, state >> 4 & 15, state >> 8 & 7) {
            (2, 1, 0) => "replace",
            (5, 6, 1) => "blend",
            (2, 2, 1) => "add",
            (1, 3, 1) => "multiply",
            (10, 2, 1) => "screen",
            _ => {
                return Err(
                    "This material's blend mode is not supported by the static HUD preview.".into(),
                )
            }
        };
        let alpha_test = if state & 0x800 != 0 {
            0
        } else {
            (state >> 12 & 3) as u8
        };
        if alpha_test == 2 {
            return Err("LT128 alpha testing is not yet verified for this preview.".into());
        }
        let alpha_test = if blend == "blend" && alpha_test == 0 {
            1
        } else {
            alpha_test
        };
        Ok(Material {
            name: name.into(),
            image,
            source,
            image_source: String::new(),
            sampler,
            blend: blend.into(),
            alpha_test,
            cull,
            levels: Vec::new(),
        })
    }

    pub fn catalogue(&self) -> Result<Catalogue, String> {
        if let Some(cache) = &self.cache {
            return Ok(cache.catalogue.clone());
        }
        Ok(self.scan_profiles()?.0)
    }

    pub(crate) fn scan_profiles(&self) -> Result<(Catalogue, Vec<Material>), String> {
        self.validate_profile()?;
        let mut names = BTreeSet::new();
        for name in self.entries.keys() {
            if let Some(name) = name.strip_prefix("materials/") {
                names.insert(name.to_string());
            }
        }
        for folder in ["raw/materials", "raw/english/materials"] {
            let base = self.root.join(folder);
            let mut pending = vec![base.clone()];
            while let Some(directory) = pending.pop() {
                if !directory.is_dir() {
                    continue;
                }
                for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                    let entry = entry.map_err(|error| error.to_string())?;
                    let kind = entry.file_type().map_err(|error| error.to_string())?;
                    if kind.is_dir() {
                        pending.push(entry.path());
                    } else if kind.is_file() {
                        let name = entry
                            .path()
                            .strip_prefix(&base)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/");
                        let logical = format!("materials/{name}").to_lowercase();
                        if !self.entries.contains_key(&logical) {
                            names.insert(name);
                        }
                    }
                }
            }
        }
        let examined = names.len();
        let materials: Vec<Material> = names
            .into_iter()
            .filter(|name| !name.starts_with("fonts/"))
            .filter_map(|name| self.material_profile(&name).ok())
            .collect();
        let names = materials
            .iter()
            .map(|material| material.name.clone())
            .collect();
        Ok((Catalogue { names, examined }, materials))
    }

    pub fn thumbnail(&self, name: &str) -> Result<Material, String> {
        let mut material = self.material(name)?;
        // Send only a small existing mip over IPC, keeping full-size pixels
        // out of the catalogue. Selecting a tile loads the original separately.
        let mip = material
            .levels
            .iter()
            .position(|level| level.width <= 128 && level.height <= 128)
            .unwrap_or(material.levels.len() - 1);
        material.levels = material.levels.split_off(mip);
        // Some custom images have no mip chain. Bound those previews too; this
        // affects only the thumbnail, never the image used by the HUD canvas.
        let level = &material.levels[0];
        if level.width > 128 || level.height > 128 {
            let ratio = 128.0 / f64::from(level.width.max(level.height));
            let width = (f64::from(level.width) * ratio).round().max(1.0) as u32;
            let height = (f64::from(level.height) * ratio).round().max(1.0) as u32;
            let mut pixels = Vec::with_capacity((width * height * 4) as usize);
            for y in 0..height {
                for x in 0..width {
                    let source_x = x * level.width / width;
                    let source_y = y * level.height / height;
                    let start = ((source_y * level.width + source_x) * 4) as usize;
                    pixels.extend_from_slice(&level.pixels[start..start + 4]);
                }
            }
            material.levels = vec![Mip {
                width,
                height,
                pixels,
            }];
        }
        Ok(material)
    }

    pub fn selected_name(&self, path: &Path) -> Result<String, String> {
        let path = path.canonicalize().map_err(|error| error.to_string())?;
        for folder in ["raw/materials", "raw/english/materials"] {
            if let Ok(root) = self.root.join(folder).canonicalize() {
                if let Ok(relative) = path.strip_prefix(root) {
                    let name = relative.to_string_lossy().replace('\\', "/");
                    // A chosen loose path identifies the logical material;
                    // resolve it with the same IWD-first rule as the tray.
                    self.read(&format!("materials/{name}"))?;
                    return Ok(name);
                }
            }
        }
        Err(
            "Select an already converted file inside this installation's raw/materials folder."
                .into(),
        )
    }

    pub fn fonts(&self) -> Result<Vec<Font>, String> {
        if let Some(cache) = &self.cache {
            let mut fonts = Vec::new();
            for font in &cache.fonts {
                let path = format!("raw/english/fonts/{}", font.name);
                match self.check_cached_file(&path) {
                    Ok(()) => fonts.push(font.clone()),
                    Err(error) => {
                        self.cache_issues
                            .lock()
                            .map_err(|_| "Unavailable font status.")?
                            .insert(format!("fonts:{}", font.name), error);
                    }
                }
            }
            return Ok(fonts);
        }
        let mut fonts = Vec::new();
        for name in [
            "normalFont",
            "bigFont",
            "smallFont",
            "consoleFont",
            "objectiveFont",
            "boldFont",
            "extraBigFont",
        ] {
            let data = fs::read(self.root.join("raw/english/fonts").join(name))
                .map_err(|_| format!("Missing stock font: raw/english/fonts/{name}"))?;
            let height = u32_at(&data, 4)?;
            let count = u32_at(&data, 8)? as usize;
            if height == 0
                || height > 4096
                || count == 0
                || count > 4096
                || 16 + count * 24 > data.len()
            {
                return Err(format!("Invalid stock font: {name}"));
            }
            let material = string_at(&data, u32_at(&data, 12)? as usize)?;
            let mut glyphs = Vec::new();
            for glyph in data[16..16 + count * 24].chunks_exact(24) {
                let mut uv = [0.0; 4];
                for (index, value) in uv.iter_mut().enumerate() {
                    *value = f32::from_le_bytes(
                        glyph[8 + index * 4..12 + index * 4].try_into().unwrap(),
                    );
                }
                if uv
                    .iter()
                    .any(|value| !value.is_finite() || *value < 0.0 || *value > 1.0)
                {
                    return Err(format!("Invalid glyph UV coordinates in {name}."));
                }
                glyphs.push(Glyph {
                    letter: u16::from_le_bytes(glyph[..2].try_into().unwrap()),
                    x: glyph[2] as i8,
                    y: glyph[3] as i8,
                    advance: glyph[4],
                    width: glyph[5],
                    height: glyph[6],
                    uv,
                });
            }
            fonts.push(Font {
                name: name.into(),
                height,
                material,
                glyphs,
            });
        }
        Ok(fonts)
    }
}
