//! Read-only access to explicitly selected local image files and folders.
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const FILE_LIMIT: u64 = 32 * 1024 * 1024;
const PIXEL_LIMIT: u64 = 32 * 1024 * 1024;
const MAX_SIDE: u32 = 8192;
const ENTRY_LIMIT: usize = 20_000;

fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| {
            matches!(
                value.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tga"
            )
        })
        .unwrap_or(false)
}

fn local(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Choose an image or folder on a local disk.".into());
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        match path.components().next() {
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) => {}
            _ => return Err(
                "Use a local drive for image references; network/device paths are not supported."
                    .into(),
            ),
        }
    }
    Ok(())
}

fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub bytes: u64,
    pub modified: u128,
}

#[derive(Serialize)]
pub struct Folder {
    pub path: String,
    pub parent: Option<String>,
    pub directories: Vec<Entry>,
    pub images: Vec<Entry>,
    pub skipped: usize,
    pub truncated: bool,
}

pub fn folder(path: String) -> Result<Folder, String> {
    let mut path = PathBuf::from(path);
    local(&path)?;
    // Opening the browser for a layer should show its containing folder,
    // including when the linked image has since been removed.
    if !path.is_dir() && (path.is_file() || supported(&path)) {
        path = path
            .parent()
            .ok_or("Choose an image folder.")?
            .to_path_buf();
    }
    let path = path
        .canonicalize()
        .map_err(|error| format!("Cannot open folder: {error}"))?;
    local(&path)?;
    let mut result = Folder {
        path: display(&path),
        parent: path.parent().map(display),
        directories: Vec::new(),
        images: Vec::new(),
        skipped: 0,
        truncated: false,
    };
    for entry in fs::read_dir(&path).map_err(|error| error.to_string())? {
        if result.directories.len() + result.images.len() >= ENTRY_LIMIT {
            result.truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let kind = match entry.file_type() {
            Ok(kind) => kind,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        if !kind.is_dir() && !(kind.is_file() && supported(&entry.path())) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                result.skipped += 1;
                continue;
            }
        };
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|time| time.as_millis())
            .unwrap_or(0);
        let file = Entry {
            name: entry.file_name().to_string_lossy().into(),
            path: display(&entry.path()),
            bytes: metadata.len(),
            modified,
        };
        if kind.is_dir() {
            result.directories.push(file);
        } else {
            result.images.push(file);
        }
    }
    result
        .directories
        .sort_by_key(|entry| entry.name.to_lowercase());
    result.images.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub data_url: String,
}

pub fn read(path: String, thumbnail: bool) -> Result<Picture, String> {
    let path = PathBuf::from(path);
    local(&path)?;
    if !supported(&path) {
        return Err("Choose a PNG, JPG, WebP, BMP or TGA image.".into());
    }
    let path = path
        .canonicalize()
        .map_err(|error| format!("Cannot read image: {error}"))?;
    local(&path)?;
    let file = fs::File::open(&path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > FILE_LIMIT {
        return Err("Choose an image smaller than 32 MB.".into());
    }
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err("Image exceeds 32 MB.".into());
    }
    let mut reader = ImageReader::with_format(
        Cursor::new(&bytes),
        ImageFormat::from_path(&path).map_err(|error| error.to_string())?,
    )
    .with_guessed_format()
    .map_err(|error| error.to_string())?;
    let format = reader.format().ok_or("Unrecognised image format.")?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::WebP
            | ImageFormat::Bmp
            | ImageFormat::Tga
    ) {
        return Err("This local image format is not supported.".into());
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|error| error.to_string())?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || u64::from(width) * u64::from(height) > PIXEL_LIMIT
        || decoder.total_bytes() > 128 * 1024 * 1024
    {
        return Err("Choose an image up to 8192 pixels per side and 32 megapixels.".into());
    }
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let (payload, mime, width, height) = if thumbnail || format == ImageFormat::Tga {
        let mut image = DynamicImage::from_decoder(decoder).map_err(|error| error.to_string())?;
        image.apply_orientation(orientation);
        if thumbnail {
            image = image.thumbnail(180, 104);
        }
        let (width, height) = (image.width(), image.height());
        let mut output = Cursor::new(Vec::new());
        image
            .write_to(&mut output, ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        (output.into_inner(), "image/png", width, height)
    } else {
        let mime = match format {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::WebP => "image/webp",
            ImageFormat::Bmp => "image/bmp",
            _ => unreachable!(),
        };
        (bytes.clone(), mime, width, height)
    };
    Ok(Picture {
        path: display(&path),
        name: path.file_name().unwrap().to_string_lossy().into(),
        width,
        height,
        data_url: format!("data:{mime};base64,{}", STANDARD.encode(payload)),
    })
}
