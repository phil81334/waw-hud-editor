//! Prepare mod sources without touching raw/, building a mod or starting WaW.
use crate::assets::{logical, Assets};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const TEXT_LIMIT: usize = 4 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 128 * 1024 * 1024;
const OWNER: &str = "// Prepared by WaW HUD Editor: ";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub mod_name: String,
    pub hud_name: String,
    pub profile: String,
    pub source: String,
    pub materials: Vec<String>,
}

/// Copying image pixels does not require a HUD host, include or build CSV.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRequest {
    pub mod_name: String,
    pub materials: Vec<String>,
}

#[derive(Serialize)]
pub struct Change {
    pub path: String,
    pub action: String,
    pub purpose: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub fingerprint: String,
    pub folder: String,
    pub changes: Vec<Change>,
    pub image_count: usize,
}

#[derive(Serialize)]
pub struct Completed {
    pub folder: String,
    pub changed: usize,
    pub backups: Vec<String>,
}

struct Output {
    path: PathBuf,
    relative: String,
    before: Option<Vec<u8>>,
    after: Vec<u8>,
    purpose: String,
}

struct Plan {
    base: PathBuf,
    outputs: Vec<Output>,
    // Source includes and CSV imports also affect whether the plan is safe.
    inputs: BTreeMap<PathBuf, Option<Vec<u8>>>,
    image_count: usize,
}

fn name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'_')
    {
        return Err("Use 1–64 letters, numbers or underscores for the HUD and mod names.".into());
    }
    Ok(())
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions are reparse points too; is_symlink alone misses them.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    logical(relative)?;
    if relative.contains(['\r', '\n', '\0']) {
        return Err("Invalid mod path.".into());
    }
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        // Reject Windows devices, streams, trailing dots and wildcard paths.
        let stem = part.split('.').next().unwrap().to_ascii_uppercase();
        if part.ends_with(['.', ' '])
            || part.contains(['*', '?', '<', '>', '|'])
            || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit())
        {
            return Err(format!("Unsupported mod path: {relative}"));
        }
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if linked(&metadata) => {
                return Err(format!(
                    "Export does not follow links or junctions: {relative}"
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(path)
}

fn read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
                return Err(format!("Not a supported export input: {}", path.display()));
            }
            fs::read(path).map(Some).map_err(|e| e.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn text(bytes: &[u8]) -> Result<&str, String> {
    if bytes.len() > TEXT_LIMIT {
        return Err("A HUD or build source exceeds 4 MB.".into());
    }
    std::str::from_utf8(bytes).map_err(|_| {
        "A HUD/build source uses an unsupported encoding. Save it as UTF-8 before preparing the mod.".into()
    })
}

impl Plan {
    fn input(&mut self, path: &Path) -> Result<Option<Vec<u8>>, String> {
        let data = read(path)?;
        self.inputs.insert(path.to_path_buf(), data.clone());
        Ok(data)
    }

    fn output(&mut self, relative: &str, after: Vec<u8>, purpose: &str) -> Result<(), String> {
        let path = safe_path(&self.base, relative)?;
        let before = self.input(&path)?;
        self.outputs.push(Output {
            path,
            relative: relative.into(),
            before,
            after,
            purpose: purpose.into(),
        });
        if self.outputs.iter().map(|v| v.after.len()).sum::<usize>() > OUTPUT_LIMIT {
            return Err("The HUD's export files exceed 128 MB. Export a smaller HUD.".into());
        }
        Ok(())
    }

    fn source(&mut self, root: &Path, relative: &str) -> Result<Vec<u8>, String> {
        let destination = safe_path(&self.base, relative)?;
        if let Some(data) = self.input(&destination)? {
            return Ok(data);
        }
        for folder in ["raw", "raw/english"] {
            let path = safe_path(root, &format!("{folder}/{relative}"))?;
            if let Some(data) = self.input(&path)? {
                return Ok(data);
            }
        }
        Err(format!("Missing Modtools source: {relative}"))
    }

    fn review(&self) -> Review {
        let mut digest = Sha256::new();
        for (path, data) in &self.inputs {
            digest.update(path.to_string_lossy().as_bytes());
            digest.update([0]);
            digest.update([u8::from(data.is_some())]);
            if let Some(data) = data {
                digest.update(Sha256::digest(data));
            }
        }
        for output in &self.outputs {
            digest.update(output.relative.as_bytes());
            digest.update(Sha256::digest(&output.after));
        }
        Review {
            fingerprint: format!("{:x}", digest.finalize()),
            folder: self.base.to_string_lossy().into(),
            changes: self
                .outputs
                .iter()
                .map(|output| Change {
                    path: output.relative.clone(),
                    action: if output.before.as_ref() == Some(&output.after) {
                        "Keep"
                    } else if output.before.is_some() {
                        "Back up + update"
                    } else {
                        "Add"
                    }
                    .into(),
                    purpose: output.purpose.clone(),
                })
                .collect(),
            image_count: self.image_count,
        }
    }
}

/// Tokens retain offsets so adding the include preserves the original bytes.
/// Preprocessor lines (including multiline macros) are kept as single tokens.
struct Token {
    value: String,
    at: usize,
    quoted: bool,
}

fn tokens(source: &str) -> Result<Vec<Token>, String> {
    let data = source.as_bytes();
    let mut at = 0;
    let mut result = Vec::new();
    while at < data.len() {
        if data[at].is_ascii_whitespace() || (at == 0 && source.starts_with('\u{feff}')) {
            at += if at == 0 && source.starts_with('\u{feff}') {
                3
            } else {
                1
            };
            continue;
        }
        if data[at..].starts_with(b"//") {
            while at < data.len() && data[at] != b'\n' {
                at += 1;
            }
            continue;
        }
        if data[at..].starts_with(b"/*") {
            at += 2;
            let end = source[at..].find("*/").ok_or("Unclosed HUD comment.")?;
            at += end + 2;
            continue;
        }
        let start = at;
        let quoted = data[at] == b'"';
        if data[at] == b'#' {
            loop {
                while at < data.len() && data[at] != b'\n' {
                    at += 1;
                }
                let continued = source[start..at].trim_end_matches('\r').ends_with('\\');
                if at < data.len() {
                    at += 1;
                }
                if !continued || at == data.len() {
                    break;
                }
            }
        } else if quoted {
            at += 1;
            while at < data.len() && data[at] != b'"' {
                if data[at] == b'\\' {
                    at += 1;
                }
                at += 1;
            }
            if at >= data.len() {
                return Err("Unclosed HUD string.".into());
            }
            at += 1;
        } else if data[at] == b'{' || data[at] == b'}' {
            at += 1;
        } else {
            while at < data.len()
                && !data[at].is_ascii_whitespace()
                && !b"{}\"#".contains(&data[at])
                && !data[at..].starts_with(b"//")
                && !data[at..].starts_with(b"/*")
            {
                at += 1;
            }
        }
        result.push(Token {
            value: source[start..at].into(),
            at: start,
            quoted,
        });
    }
    Ok(result)
}

// The PC safe-area block is always registered, but its stock item include is
// console-only. Reuse that existing menu asset rather than inventing a new name
// which would not be present in the game's already-loaded common HUD list.
fn add_hook(source: &str, include: &str, profile: &str) -> Result<String, String> {
    const BEGIN: &str = "// WAW_HUD_EDITOR_INCLUDE_BEGIN";
    const END: &str = "// WAW_HUD_EDITOR_INCLUDE_END";
    let mut clean = source.to_string();
    let starts: Vec<_> = clean.match_indices(BEGIN).map(|(at, _)| at).collect();
    let ends: Vec<_> = clean.match_indices(END).map(|(at, _)| at).collect();
    if starts.len() > 1 || starts.len() != ends.len() {
        return Err(
            "The export include markers were changed. Restore the host from its backup first."
                .into(),
        );
    }
    if let (Some(start), Some(end)) = (starts.first(), ends.first()) {
        if end < start {
            return Err("Invalid export include markers.".into());
        }
        // Remove only the owned include, retaining all other source bytes.
        let after = clean[*end + END.len()..]
            .find('\n')
            .map(|at| *end + END.len() + at + 1)
            .unwrap_or(clean.len());
        let before = clean[..*start].rfind('\n').map(|at| at + 1).unwrap_or(0);
        let old = &clean[*start + BEGIN.len()..*end];
        let old_tokens = tokens(old)?;
        if old_tokens.len() != 1 || !old_tokens[0].value.trim().starts_with("#include \"") {
            return Err("The owned export hook contains custom code. Move it outside the markers before exporting.".into());
        }
        clean.replace_range(before..after, "");
    }
    let list = tokens(&clean)?;
    let slot = if profile == "sp" {
        "safearea"
    } else {
        "safeareaa"
    };
    let mut depth = 0_i32;
    let mut conditional = 0_i32;
    let mut selected = None;
    let mut roots = 0;
    let mut index = 0;
    while index < list.len() {
        let token = &list[index];
        let value = token.value.trim();
        if !token.quoted && value.starts_with('#') {
            match value[1..]
                .trim_start()
                .split_whitespace()
                .next()
                .unwrap_or("")
            {
                "if" | "ifdef" | "ifndef" => conditional += 1,
                "endif" => conditional -= 1,
                _ => {}
            }
        }
        if depth == 1 && conditional == 0 && !token.quoted && value.eq_ignore_ascii_case("menuDef")
        {
            if list.get(index + 1).map(|v| v.value.as_str()) != Some("{") {
                return Err("Unsupported HUD menu definition.".into());
            }
            let mut nesting = 1;
            let mut end = index + 2;
            while end < list.len() && nesting > 0 {
                if !list[end].quoted {
                    if list[end].value == "{" {
                        nesting += 1;
                    }
                    if list[end].value == "}" {
                        nesting -= 1;
                    }
                }
                end += 1;
            }
            if nesting != 0 {
                return Err("Unclosed HUD menu definition.".into());
            }
            let body = &list[index + 2..end - 1];
            if body.windows(2).any(|pair| {
                pair[0].value.eq_ignore_ascii_case("name")
                    && pair[1].value.trim_matches('"').eq_ignore_ascii_case(slot)
            }) {
                if selected.is_some() {
                    return Err("Duplicate safe-area HUD blocks need manual integration.".into());
                }
                // Accept the stock PC slot only. Existing custom HUD items,
                // expressions or different parents must never be discarded.
                let values: Vec<&str> = body.iter().map(|v| v.value.trim()).collect();
                let expected = [
                    "name",
                    if profile == "sp" {
                        "\"safearea\""
                    } else {
                        "\"safeareaa\""
                    },
                    "rect",
                    "0",
                    "0",
                    "640",
                    "480",
                ];
                if values.len() != 14
                    || values[..7] != expected
                    || !["HORIZONTAL_ALIGN_FULLSCREEN", "4", "0"].contains(&values[7])
                    || !["VERTICAL_ALIGN_FULLSCREEN", "4", "0"].contains(&values[8])
                    || values[9] != "fullScreen"
                    || values[10] != "0"
                    || values[11] != "visible"
                    || values[12] != "1"
                    || values[13] != "#include \"ui/safearea.menu\""
                {
                    return Err("This mod has a custom safe-area HUD block. Use manual export to integrate it without replacing custom code.".into());
                }
                selected = Some((
                    body[2].at,
                    body[8].at + body[8].value.len(),
                    list[end - 1].at,
                ));
            }
        }
        if !token.quoted && value == "{" {
            if depth == 0 {
                roots += 1;
            }
            depth += 1;
        }
        if !token.quoted && value == "}" {
            depth -= 1;
        }
        if depth < 0 || conditional < 0 {
            return Err("Unbalanced HUD source.".into());
        }
        index += 1;
    }
    if depth != 0 || conditional != 0 || roots != 1 {
        return Err(
            "The existing HUD source needs manual integration; no files were changed.".into(),
        );
    }
    let (start, end, closing) = selected.ok_or(
        "The stock safe-area HUD block is missing. Use manual export for this custom HUD.",
    )?;
    let newline = if clean.contains("\r\n") { "\r\n" } else { "\n" };
    let insertion =
        format!("    {BEGIN}{newline}    #include \"{include}\"{newline}    {END}{newline}");
    // Insert at the start of the closing-brace line, so repeat exports retain
    // the same whitespace rather than accumulating blank lines.
    let line = clean[..closing]
        .rfind('\n')
        .map(|at| at + 1)
        .unwrap_or(closing);
    clean.insert_str(line, &insertion);
    clean.replace_range(start..end, "rect 0 0 640 480 0 0");
    Ok(clean)
}

fn fragment(source: &str) -> Result<(), String> {
    if !source.is_ascii() || source.len() > TEXT_LIMIT {
        return Err("The exported INC must be ASCII and smaller than 4 MB.".into());
    }
    let list = tokens(source)?;
    let mut depth = 0;
    let mut count = 0;
    let mut opening = false;
    for token in list {
        if token.quoted {
            continue;
        }
        if token.value.starts_with('#') {
            return Err("Unexpected directive in generated HUD items.".into());
        }
        if depth == 0 {
            if token.value.eq_ignore_ascii_case("itemDef") && !opening {
                opening = true;
                count += 1;
                continue;
            }
            if token.value != "{" || !opening {
                return Err("Expected generated itemDef blocks.".into());
            }
            opening = false;
        }
        if token.value == "{" {
            depth += 1;
        }
        if token.value == "}" {
            depth -= 1;
        }
        if depth < 0 {
            return Err("Unbalanced generated HUD items.".into());
        }
    }
    if depth != 0 || opening || count == 0 || count > 256 {
        return Err("Export between 1 and 256 HUD items.".into());
    }
    Ok(())
}

fn csv_key(line: &str) -> Option<(String, String)> {
    let mut fields = line.trim_start_matches('\u{feff}').split(',');
    let kind = fields.next()?.trim().to_ascii_lowercase();
    if kind.is_empty() || kind.starts_with("//") || kind.starts_with('#') {
        return None;
    }
    let value = fields
        .next()?
        .trim()
        .trim_matches('"')
        .replace('\\', "/")
        .to_ascii_lowercase();
    Some((kind, value))
}

fn imported_rows(
    plan: &mut Plan,
    root: &Path,
    csv: &str,
    seen: &mut BTreeSet<String>,
    rows: &mut BTreeSet<(String, String)>,
) -> Result<(), String> {
    for line in csv.lines() {
        let Some((kind, value)) = csv_key(line) else {
            continue;
        };
        if kind == "include" {
            logical(&value)?;
            if seen.len() > 128 {
                return Err("Too many CSV imports to check safely.".into());
            }
            if !seen.insert(value.clone()) {
                continue;
            }
            let path = safe_path(root, &format!("zone_source/{value}.csv"))?;
            let data = plan
                .input(&path)?
                .ok_or_else(|| format!("Missing CSV include: {value}.csv"))?;
            imported_rows(plan, root, text(&data)?, seen, rows)?;
        } else {
            rows.insert((kind, value));
        }
    }
    Ok(())
}

fn check_archives(root: &Path, base: &Path, sources: &[&str]) -> Result<(), String> {
    for directory in [root.join("main"), base.to_path_buf()] {
        if !directory.is_dir() {
            continue;
        }
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path
                .extension()
                .is_none_or(|value| !value.eq_ignore_ascii_case("iwd"))
            {
                continue;
            }
            let file = fs::File::open(&path).map_err(|e| e.to_string())?;
            let archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
            for name in archive.file_names() {
                let name = name.replace('\\', "/").to_lowercase();
                if sources
                    .iter()
                    .any(|source| name.eq_ignore_ascii_case(source))
                {
                    return Err(format!("{} contains the HUD source {name}, which would hide the exported loose file. Remove that source from the IWD first; HUD sources belong in the FF build, not the IWD.", path.display()));
                }
            }
        }
    }
    Ok(())
}

fn build(assets: &Assets, request: &Request, copy_images: bool) -> Result<Plan, String> {
    name(&request.mod_name)?;
    name(&request.hud_name)?;
    fragment(&request.source)?;
    let directory = match request.profile.as_str() {
        "sp" => "ui",
        "mp" => "ui_mp",
        _ => return Err("Choose Single-player / Zombies or Multiplayer.".into()),
    };
    let root = &assets.root;
    let base = safe_path(root, &format!("mods/{}", request.mod_name))?;
    if !base.is_dir() {
        return Err("Choose an existing mod folder.".into());
    }
    let mut plan = Plan {
        base,
        outputs: Vec::new(),
        inputs: BTreeMap::new(),
        image_count: 0,
    };
    if request.hud_name.len() > 40 {
        return Err("Keep the HUD filename to 40 characters or fewer.".into());
    }
    let menu_name = format!("waw_hud_{}", request.hud_name);
    let include = format!("{directory}/{}.inc", request.hud_name);
    let menu = format!("{directory}/hud.menu");
    let listing = format!("{directory}/hud.txt");
    let host = format!("{directory}/waw_hud_editor.menu");
    let host_list = format!("{directory}/waw_hud_editor.txt");
    let host_marker = format!("{OWNER}host_{}\n", request.profile);
    let csv_path = safe_path(&plan.base, "mod.csv")?;
    let csv_bytes = plan.input(&csv_path)?.unwrap_or_default();
    let csv = text(&csv_bytes)?;
    let use_list = csv.lines().any(|line| {
        csv_key(line).is_some_and(|key| {
            key == ("menufile".into(), listing.clone())
                || key == ("menufile".into(), host_list.clone())
        })
    });
    let build_source = if use_list { &host_list } else { &host };
    check_archives(root, &plan.base, &[&host, &host_list, &include])?;

    let list_bytes = plan.source(root, &listing)?;
    let list_source = text(&list_bytes)?;
    let filenames: Vec<_> = tokens(list_source)?
        .into_iter()
        .filter(|token| token.quoted)
        .map(|token| token.value.trim_matches('"').to_string())
        .collect();
    let expected = if request.profile == "sp" {
        vec![menu.clone(), "ui/objective_info.menu".into()]
    } else {
        vec![menu.clone()]
    };
    if filenames != expected {
        return Err("The HUD list has been customised. Use manual export so the editor does not guess which menus your game loads.".into());
    }
    // A unique build filename prevents the linker's loose raw/hud.menu from
    // silently winning over the mod's copy. Never change global raw sources.
    for folder in [
        "raw",
        "raw_shared",
        "devraw",
        "devraw_shared",
        "main",
        "raw/english",
    ] {
        let path = safe_path(root, &format!("{folder}/{host}"))?;
        if plan.input(&path)?.is_some() {
            return Err(format!("{folder}/{host} shadows the mod export. Rename or move that conflicting source first."));
        }
        let path = safe_path(root, &format!("{folder}/{host_list}"))?;
        if plan.input(&path)?.is_some() {
            return Err(format!("{folder}/{host_list} shadows the mod export. Rename or move that conflicting source first."));
        }
    }
    let destination = safe_path(&plan.base, &host)?;
    let menu_bytes = if let Some(existing) = plan.input(&destination)? {
        if !existing.starts_with(host_marker.as_bytes()) {
            return Err(format!(
                "{host} already belongs to another file. Use manual export."
            ));
        }
        existing[host_marker.len()..].to_vec()
    } else {
        plan.source(root, &menu)?
    };
    let safearea = plan.source(root, "ui/safearea.menu")?;
    if format!("{:x}", Sha256::digest(&safearea))
        != "a0a9ea27307ca579f591f40cb63c790a8645a30b82ac9e02773d217327755ac1"
    {
        return Err("The safe-area item include has been customised. Use manual export so those items stay intact.".into());
    }
    let patched = add_hook(text(&menu_bytes)?, &include, &request.profile)?;
    plan.output(
        &host,
        format!("{host_marker}{patched}").into_bytes(),
        "Copy of the HUD with your include in its stock PC slot",
    )?;
    let path = safe_path(&plan.base, &include)?;
    if let Some(existing) = plan.input(&path)? {
        if !existing.starts_with(format!("{OWNER}{menu_name}\n").as_bytes()) {
            return Err(format!(
                "{include} already belongs to another file. Choose a different HUD filename."
            ));
        }
    }
    plan.output(
        &include,
        format!("{OWNER}{menu_name}\n{}", request.source).into_bytes(),
        "Your HUD layout",
    )?;
    if use_list {
        let path = safe_path(&plan.base, &host_list)?;
        let marker = format!("{OWNER}list_{}\n", request.profile);
        if let Some(existing) = plan.input(&path)? {
            if !existing.starts_with(marker.as_bytes()) {
                return Err(format!(
                    "{host_list} already belongs to another file. Use manual export."
                ));
            }
        }
        let copied = list_source.replace(&format!("\"{menu}\""), &format!("\"{host}\""));
        plan.output(
            &host_list,
            format!("{marker}{copied}").into_bytes(),
            "Preserve the other menus in your existing HUD list",
        )?;
    }

    let mut images = BTreeSet::new();
    let mut materials = BTreeSet::new();
    if request.materials.len() > 256 {
        return Err("Too many material dependencies.".into());
    }
    for material_name in &request.materials {
        logical(material_name)?;
        if !materials.insert(material_name.to_lowercase()) {
            continue;
        }
        let material = assets.material(material_name)?;
        let relative = format!("materials/{material_name}");
        let (compiled, _) = assets.read(&relative)?;
        let installed = plan.source(root, &relative)?;
        if installed != compiled {
            return Err(format!("{material_name}: the mod uses a different converted material from the preview. Resolve that override before exporting."));
        }
        // Material metadata belongs in the FF; IWI pixel data belongs in the IWD.
        if copy_images {
            let image = format!("images/{}.iwi", material.image);
            if images.insert(image.clone()) {
                let (bytes, _) = assets.read(&image)?;
                plan.output(&image, bytes, "Image pixels for the mod IWD")?;
            }
        }
    }
    plan.image_count = images.len();

    let newline = if csv.contains("\r\n") { "\r\n" } else { "\n" };
    let mut inherited = BTreeSet::new();
    let imports = csv
        .lines()
        .filter(|line| csv_key(line).is_some_and(|(kind, _)| kind == "include"))
        .collect::<Vec<_>>()
        .join("\n");
    imported_rows(
        &mut plan,
        root,
        &imports,
        &mut BTreeSet::new(),
        &mut inherited,
    )?;
    if inherited.contains(&("menufile".into(), menu.clone()))
        || inherited.contains(&("menufile".into(), listing.clone()))
        || inherited.contains(&("menufile".into(), host.clone()))
        || inherited.contains(&("menufile".into(), host_list.clone()))
    {
        return Err(format!("A CSV include already builds {menu}. Remove that row from its included CSV before using automatic export, so the HUD is not compiled twice."));
    }
    let mut rows = inherited;
    let mut lines = Vec::new();
    let mut kept_build_source = false;
    for line in csv.split_inclusive('\n') {
        if let Some(key) = csv_key(line) {
            if key.0 == "menufile" && [&menu, &listing, &host, &host_list].contains(&&key.1) {
                // Keep the desired row in place, but compile the copied HUD
                // only once even if an older setup listed both menu and list.
                if key.1 != *build_source || kept_build_source {
                    continue;
                }
                kept_build_source = true;
            }
            rows.insert(key);
        }
        lines.push(line);
    }
    let mut updated = lines.concat();
    for key in std::iter::once(("menufile".to_string(), build_source.clone())).chain(
        materials
            .into_iter()
            .map(|value| ("material".into(), value)),
    ) {
        if rows.insert(key.clone()) {
            if !updated.is_empty() && !updated.ends_with('\n') {
                updated.push_str(newline);
            }
            updated.push_str(&format!("{},{}{}", key.0, key.1, newline));
        }
    }
    plan.output(
        "mod.csv",
        updated.into_bytes(),
        "Build the HUD and its materials into mod.ff",
    )?;
    let selection = format!("{}.files", request.mod_name);
    let selection_path = safe_path(&plan.base, &selection)?;
    let selected_bytes = plan.input(&selection_path)?.unwrap_or_default();
    let mut selected = String::new();
    for line in text(&selected_bytes)?.split_inclusive('\n') {
        let name = line.trim().replace('\\', "/").to_lowercase();
        if name.contains(['*', '?']) {
            return Err("The IWD selection uses wildcards. Select individual files in Launcher first so HUD sources cannot hide newer exports.".into());
        }
        // These sources are preprocessed into the FF. Packing old copies into
        // an IWD makes the linker prefer them over the next loose-file export.
        if [&host, &host_list, &include]
            .iter()
            .any(|path| name.eq_ignore_ascii_case(path))
        {
            continue;
        }
        selected.push_str(line);
    }
    let existing: BTreeSet<String> = selected
        .lines()
        .map(|line| line.trim().replace('\\', "/").to_lowercase())
        .collect();
    for image in images {
        if !existing.contains(&image.to_lowercase()) {
            if !selected.is_empty() && !selected.ends_with('\n') {
                selected.push_str("\r\n");
            }
            selected.push_str(&image.replace('/', "\\"));
            selected.push_str("\r\n");
        }
    }
    if !selected.is_empty() || selected_bytes.len() > 0 {
        plan.output(
            &selection,
            selected.into_bytes(),
            "Select HUD images for Launcher’s IWD build",
        )?;
    }
    Ok(plan)
}

pub fn mods(root: &Path) -> Result<Vec<String>, String> {
    let directory = safe_path(root, "mods")?;
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let value = entry.file_name().to_string_lossy().into_owned();
        if name(&value).is_ok() && entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            safe_path(root, &format!("mods/{value}"))?;
            names.push(value);
        }
    }
    names.sort_by_key(|value| value.to_lowercase());
    Ok(names)
}

pub fn review(assets: &Assets, request: &Request) -> Result<Review, String> {
    Ok(build(assets, request, true)?.review())
}

pub fn prepare(assets: &Assets, request: &Request, fingerprint: &str) -> Result<Completed, String> {
    apply_plan(build(assets, request, true)?, fingerprint)
}

/// HUD setup keeps the existing source integration but leaves image copying
/// to the independent Images action. Neither action depends on the other.
pub fn review_setup(assets: &Assets, request: &Request) -> Result<Review, String> {
    Ok(build(assets, request, false)?.review())
}

pub fn prepare_setup(
    assets: &Assets,
    request: &Request,
    fingerprint: &str,
) -> Result<Completed, String> {
    apply_plan(build(assets, request, false)?, fingerprint)
}

fn image_plan(assets: &Assets, request: &ImageRequest) -> Result<Plan, String> {
    name(&request.mod_name)?;
    if request.materials.is_empty() || request.materials.len() > 256 {
        return Err("Choose a HUD with 1–256 image materials to copy.".into());
    }
    let base = safe_path(&assets.root, &format!("mods/{}", request.mod_name))?;
    if !base.is_dir() {
        return Err("Choose an existing mod folder.".into());
    }
    let mut plan = Plan {
        base,
        outputs: Vec::new(),
        inputs: BTreeMap::new(),
        image_count: 0,
    };
    let mut materials = BTreeSet::new();
    let mut images = BTreeSet::new();
    for name in &request.materials {
        logical(name)?;
        if !materials.insert(name.to_lowercase()) {
            continue;
        }
        let material = assets.material(name)?;
        let image = format!("images/{}.iwi", material.image);
        if images.insert(image.clone()) {
            let (bytes, _) = assets.read(&image)?;
            plan.output(&image, bytes, "Image pixels for the mod IWD")?;
        }
    }
    plan.image_count = images.len();

    // Preserve every existing selection, including custom HUD sources. This
    // action only adds the image paths; it never edits a menu, INC or CSV.
    let selection = format!("{}.files", request.mod_name);
    let selection_path = safe_path(&plan.base, &selection)?;
    let selected_bytes = plan.input(&selection_path)?.unwrap_or_default();
    let mut selected = text(&selected_bytes)?.to_string();
    let existing: BTreeSet<String> = selected
        .lines()
        .map(|line| line.trim().replace('\\', "/").to_lowercase())
        .collect();
    for image in images {
        if !existing.contains(&image.to_lowercase()) {
            if !selected.is_empty() && !selected.ends_with('\n') {
                selected.push_str("\r\n");
            }
            selected.push_str(&image.replace('/', "\\"));
            selected.push_str("\r\n");
        }
    }
    plan.output(
        &selection,
        selected.into_bytes(),
        "Select HUD images for Launcher’s IWD build",
    )?;
    Ok(plan)
}

pub fn review_images(assets: &Assets, request: &ImageRequest) -> Result<Review, String> {
    Ok(image_plan(assets, request)?.review())
}

pub fn prepare_images(
    assets: &Assets,
    request: &ImageRequest,
    fingerprint: &str,
) -> Result<Completed, String> {
    apply_plan(image_plan(assets, request)?, fingerprint)
}

// Both independent actions retain the tested backup, stale-review and
// rollback behaviour. This is the original publisher shared by both plans.
fn apply_plan(plan: Plan, fingerprint: &str) -> Result<Completed, String> {
    if plan.review().fingerprint != fingerprint {
        return Err(
            "Files changed since the review. Review the mod again before exporting.".into(),
        );
    }
    let changes: Vec<&Output> = plan
        .outputs
        .iter()
        .filter(|output| output.before.as_ref() != Some(&output.after))
        .collect();
    // Stage all new contents and publish complete backups before updating any
    // destination. On an error, restore the files already changed in this run.
    let staging = tempfile::Builder::new()
        .prefix(".hud-export-")
        .tempdir_in(&plan.base)
        .map_err(|e| e.to_string())?;
    for (index, output) in changes.iter().enumerate() {
        fs::write(staging.path().join(index.to_string()), &output.after)
            .map_err(|e| e.to_string())?;
    }
    for (path, expected) in &plan.inputs {
        if read(path)? != *expected {
            return Err("A source changed during export. Review the mod again.".into());
        }
    }
    let mut backups = Vec::new();
    for output in &changes {
        if let Some(bytes) = &output.before {
            let parent = output.path.parent().unwrap();
            let filename = output.path.file_name().unwrap().to_string_lossy();
            let mut index = 1;
            loop {
                let backup = output
                    .path
                    .with_file_name(format!("{filename}.backup-{index}"));
                // Never follow an existing backup's link or overwrite a file.
                if fs::symlink_metadata(&backup).is_ok() {
                    index += 1;
                    continue;
                }
                let mut copy =
                    tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
                copy.write_all(bytes).map_err(|e| e.to_string())?;
                copy.as_file().sync_all().map_err(|e| e.to_string())?;
                copy.persist_noclobber(&backup).map_err(|e| e.to_string())?;
                backups.push(format!("{}.backup-{index}", output.relative));
                break;
            }
        }
    }
    let mut written: Vec<&Output> = Vec::new();
    for (index, output) in changes.iter().enumerate() {
        let result = (|| -> Result<(), String> {
            safe_path(&plan.base, &output.relative)?;
            if read(&output.path)? != output.before {
                return Err("A destination changed during export.".into());
            }
            fs::create_dir_all(output.path.parent().unwrap()).map_err(|e| e.to_string())?;
            let bytes =
                fs::read(staging.path().join(index.to_string())).map_err(|e| e.to_string())?;
            atomic_write(&output.path, &bytes, output.before.is_none())
        })();
        if let Err(error) = result {
            let mut failures = Vec::new();
            for previous in written.into_iter().rev() {
                // Do not roll back over an edit made by another process.
                if safe_path(&plan.base, &previous.relative).is_err()
                    || read(&previous.path).ok().flatten().as_ref() != Some(&previous.after)
                {
                    failures.push(previous.relative.clone());
                    continue;
                }
                let restored = if let Some(bytes) = &previous.before {
                    atomic_write(&previous.path, bytes, false)
                } else {
                    fs::remove_file(&previous.path).map_err(|e| e.to_string())
                };
                if restored.is_err() {
                    failures.push(previous.relative.clone());
                }
            }
            if !failures.is_empty() {
                return Err(format!(
                    "{error} Restore these files from their numbered backups: {}",
                    failures.join(", ")
                ));
            }
            return Err(format!("{error} Changes from this export were rolled back; any completed backups were kept."));
        }
        written.push(output);
    }
    Ok(Completed {
        folder: plan.base.to_string_lossy().into(),
        changed: changes.len(),
        backups,
    })
}

fn atomic_write(path: &Path, bytes: &[u8], new: bool) -> Result<(), String> {
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    if new {
        file.persist_noclobber(path).map_err(|e| e.to_string())?;
    } else {
        file.persist(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
