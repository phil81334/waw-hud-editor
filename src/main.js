import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { version } from "../package.json";
import {
  createProject,
  createItem,
  validateProject,
  token,
  number,
  rgba,
  exportInc,
  History,
} from "./document.js";
import { bounds, setBounds, fontFor, axis } from "./layout.js";
import { Workspace } from "./workspace.js";
import { AssetTray } from "./assets.js";
import { visualBounds, moveVisualTo } from "./text-controls.js";
import { ModExport } from "./mod-export.js";
import { LayerList } from "./layer-list.js";
import { NumberScrubber } from "./number-scrubber.js";
import { LocalMedia, imageFilters, filename } from "./local-media.js";

const element = (id) => document.getElementById(id);
const desktop = Boolean(window.__TAURI_INTERNALS__);
let project = createProject();
let selection = new Set();
let history = new History(project);
let saved = JSON.stringify(project);
let projectPath = null;
let workspace;
let assetTray;
let layerList;
let numberScrubber;
let localMedia;
let clipboard = [];
let busy = false;
const resources = {
  fonts: [],
  materials: new Map(),
  errors: new Map(),
  fontFor: (item, viewport) => fontFor(item, viewport, resources.fonts),
};

function escape(text) {
  return String(text).replace(
    /[&<>"']/g,
    (value) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        value
      ],
  );
}

function message(text, error = false) {
  element("message").textContent = text;
  element("message").className = error ? "error" : "success";
  element("status").textContent = error ? "Needs attention" : "Done";
}

async function action(work) {
  if (busy) {
    return;
  }
  busy = true;
  element("status").textContent = "Working…";
  try {
    await work();
  } catch (error) {
    message(String(error.message || error), true);
  } finally {
    busy = false;
    if (element("status").textContent === "Working…") {
      element("status").textContent = "Ready";
    }
  }
}

function selected() {
  return project.items.filter((item) => selection.has(item.id));
}

// Grouping is useful only when it changes the selected layers' membership.
function groupState() {
  const items = selected();
  const firstGroup = items[0]?.group;
  const alreadyGrouped =
    Boolean(firstGroup) && items.every((item) => item.group === firstGroup);
  return {
    items,
    canGroup: items.length >= 2 && !alreadyGrouped,
    canUngroup: items.some((item) => Boolean(item.group)),
  };
}

function changed(commit = true) {
  if (commit) {
    project = validateProject(project);
    history.commit(project);
  }
  selection = new Set(
    [...selection].filter((id) => project.items.some((item) => item.id === id)),
  );
  element("project-name").textContent =
    `${project.name}${JSON.stringify(project) !== saved ? " *" : ""}`;
  element("item-count").textContent = `${project.items.length} / 256`;
  element("undo").disabled = history.cursor === 0;
  element("redo").disabled = history.cursor === history.entries.length - 1;
  localMedia?.sync(project);
  renderLayers();
  renderInspector();
  updateBackground();
  workspace?.draw();
}

function choose(ids) {
  selection = ids;
  renderLayers();
  renderInspector();
  workspace?.draw();
}

function choice(title, text, buttons) {
  return new Promise((resolve) => {
    const dialog = element("choice-dialog");
    element("choice-title").textContent = title;
    element("choice-message").textContent = text;
    element("choice-buttons").replaceChildren();
    let resolved = false;
    const finish = (value) => {
      if (!resolved) {
        resolved = true;
        dialog.close();
        resolve(value);
      }
    };
    for (const [label, value] of buttons) {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => finish(value));
      element("choice-buttons").append(button);
    }
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish("cancel");
    };
    dialog.showModal();
  });
}

async function canDiscard() {
  if (JSON.stringify(project) === saved) {
    return true;
  }
  const answer = await choice(
    "Unsaved HUD",
    "Save your project before continuing?",
    [
      ["Cancel", "cancel"],
      ["Discard changes", "discard"],
      ["Save project", "save"],
    ],
  );
  if (answer === "save") {
    return saveProject();
  }
  return answer === "discard";
}

async function write(path, contents) {
  try {
    await invoke("write_document", { path, contents, mode: "new" });
    return true;
  } catch (error) {
    if (String(error) !== "EXISTS") {
      throw error;
    }
  }
  const mode = await choice(
    "File already exists",
    "Keep a backup of the old file, or replace it?",
    [
      ["Cancel", "cancel"],
      ["Replace", "replace"],
      ["Back up and replace", "backup"],
    ],
  );
  if (mode === "cancel") {
    return false;
  }
  await invoke("write_document", { path, contents, mode });
  return true;
}

async function saveProject(saveAs = false) {
  if (!desktop) {
    throw new Error("Open the desktop app to save project files.");
  }
  const checked = validateProject(project);
  const path =
    !saveAs && projectPath
      ? projectPath
      : await save({
          title: "Save HUD project",
          defaultPath: projectPath || "Untitled HUD.wawhud",
          filters: [{ name: "HUD project", extensions: ["wawhud"] }],
        });
  if (!path) {
    return false;
  }
  checked.name = path
    .split(/[\\/]/)
    .pop()
    .replace(/\.wawhud$/i, "");
  const contents = JSON.stringify(checked, null, 2) + "\n";
  if (!saveAs && projectPath) {
    // Saving the active document is an explicit update to that file. Only a
    // newly chosen destination needs the replace/backup choice.
    await invoke("write_document", { path, contents, mode: "replace" });
  } else {
    if (!(await write(path, contents))) {
      return false;
    }
  }
  project = checked;
  projectPath = path;
  saved = JSON.stringify(project);
  changed();
  message(`Project saved: ${path}`);
  return true;
}

async function material(name = null, path = null) {
  let value;
  try {
    value = await invoke("load_material", { name, path });
  } catch (error) {
    // A retained thumbnail can outlive its source. Selecting it rechecks that
    // source; count a rejected load too, rather than leaving a stale tile usable.
    if (name && !name.startsWith("fonts/")) {
      assetTray?.skip("materials", name, error);
    }
    throw error;
  }
  for (const level of value.levels) {
    level.pixels = new Uint8Array(level.pixels);
  }
  // Retain a small palette without keeping every material ever opened alive.
  // Assets already used by the document and stock fonts are never evicted.
  const bytes = (asset) =>
    asset.levels.reduce((sum, level) => sum + level.pixels.byteLength, 0);
  const used = new Set(project.items.map((item) => item.material));
  for (const font of resources.fonts) {
    used.add(font.material);
  }
  let total = bytes(value);
  for (const [key, asset] of resources.materials) {
    if (key !== value.name) {
      total += bytes(asset);
    }
  }
  for (const [key, asset] of resources.materials) {
    if (total <= 64 * 1024 * 1024) {
      break;
    }
    if (!used.has(key) && key !== value.name) {
      total -= bytes(asset);
      resources.materials.delete(key);
      workspace?.renderer.clearTextures();
    }
  }
  if (total > 64 * 1024 * 1024) {
    throw new Error(
      "This HUD exceeds the 64 MB decoded-image preview budget. Use smaller converted images.",
    );
  }
  resources.materials.set(value.name, value);
  resources.errors.delete(value.name);
  return value;
}

async function loadAssets() {
  if (!desktop) {
    return;
  }
  const names = new Set([
    ...resources.materials.keys(),
    ...project.items
      .filter((item) => item.material)
      .map((item) => item.material),
  ]);
  resources.materials.clear();
  resources.errors.clear();
  workspace?.renderer.clearTextures();
  resources.fonts = await invoke("load_fonts");
  for (const font of resources.fonts) {
    names.add(font.material);
  }
  for (const name of names) {
    try {
      await material(name);
    } catch (error) {
      resources.errors.set(name, String(error));
    }
  }
  assetTray?.refreshFonts();
  changed(false);
  const errors = [...resources.errors].map(
    ([name, error]) => `${name}: ${error}`,
  );
  if (errors.length) {
    message(errors.join(" · "), true);
  } else {
    message("Ready. Add text, a rectangle or a converted 2D material.");
  }
}

function placeItem(item, point) {
  moveVisualTo(item, point, project.viewport, resources.fonts);
  if (workspace.snap) {
    for (const coordinate of [0, 1]) {
      item.rect[coordinate] = token(
        Math.round(number(item.rect[coordinate]) / workspace.snapSize) *
          workspace.snapSize,
      );
    }
  }
}

function add(kind, materialValue = null, point = null) {
  if (project.items.length >= 256) {
    throw new Error(
      "The native HUD host limit is 256 items, including any existing host items.",
    );
  }
  const item = createItem(kind, project.items);
  if (materialValue) {
    item.material = materialValue.name;
    if (materialValue.localPath) {
      item.material = "";
      item.localImage = { path: materialValue.localPath };
    }
    const image = materialValue.levels[0];
    const scale = Math.min(1, 240 / Math.max(image.width, image.height));
    item.rect[2] = token(image.width * scale);
    item.rect[3] = token(image.height * scale);
  }
  if (point) {
    placeItem(item, point);
  }
  project.items.push(item);
  selection = new Set([item.id]);
  changed();
}

function renderLayers() {
  layerList?.render();
  for (const id of ["delete", "duplicate", "layer-up", "layer-down"]) {
    element(id).disabled = selection.size === 0;
  }
  const groups = groupState();
  element("group").disabled = !groups.canGroup;
  element("ungroup").disabled = !groups.canUngroup;
}

const anchorsX = [
  "4:3 left",
  "Screen left",
  "Screen centre",
  "Screen right",
  "Full-width scale",
  "Pixels / no scale",
  "Inverse scale",
  "Safe-area centre",
];
const anchorsY = [
  "4:3 top",
  "Screen top",
  "Screen centre",
  "Screen bottom",
  "Full-height scale",
  "Pixels / no scale",
  "Inverse scale",
  "Safe-area centre",
];
const fonts = [
  "Default (adaptive)",
  "Normal",
  "Big",
  "Small",
  "Bold (adaptive)",
  "Console",
  "Objective",
];

function input(label, path, value, type = "number") {
  const numeric = type === "number";
  const step = path === "scale" ? 0.01 : path === "thickness" ? 0.1 : 1;
  const title =
    "Drag left/right to adjust. Shift: finer steps. Ctrl: larger steps.";
  const caption = numeric
    ? '<span class="scrub-label" data-scrub data-scrub-step="' +
      step +
      '" title="' +
      title +
      '">' +
      escape(label) +
      "</span>"
    : escape(label);
  const minimum = ["scale", "thickness"].includes(path) ? 0 : -1000000;
  const limits = numeric
    ? 'step="any" min="' + minimum + '" max="1000000"'
    : "";
  return (
    '<label class="field">' +
    caption +
    '<input data-field="' +
    path +
    '" type="' +
    type +
    '" value="' +
    escape(value) +
    '" ' +
    limits +
    "/></label>"
  );
}

function select(label, path, value, options) {
  return `<label class="field">${label}<select data-field="${path}">${options.map(([id, name]) => `<option value="${id}"${value === id ? " selected" : ""}>${name}</option>`).join("")}</select></label>`;
}

function colour(label, path, values) {
  const rgb = rgba(values)
    .slice(0, 3)
    .map((value) =>
      Math.round(value * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
  return `<div class="colour-row"><label>${label}<input type="color" data-colour="${path}" value="#${rgb}" /></label><label><span class="scrub-label" data-scrub data-scrub-step="1" title="Drag left/right to adjust. Shift: finer steps. Ctrl: larger steps.">Alpha</span> <input type="number" min="0" max="100" step="any" data-alpha="${path}" value="${Number((number(values[3]) * 100).toFixed(3))}" />%</label></div>`;
}

function renderInspector() {
  const items = selected();
  element("selection-count").textContent = items.length
    ? `${items.length} selected`
    : "No selection";
  if (!items.length) {
    element("inspector").innerHTML =
      '<div class="empty-inspector"><strong>Compose your HUD</strong><p>Add text, a rectangle or a converted material. Select a layer to change its layout and appearance.</p><p>Shift-click for multiple layers. Editor hiding and locking do not change the exported HUD.</p></div>';
    return;
  }
  const alignTools = `<section class="property-section"><h3>Align layers</h3><label class="field">Relative to<select id="align-target"><option value="selection">Selection bounds</option><option value="artboard">Preview artboard</option></select></label><div class="alignment-tools">${["Left", "Centre X", "Right", "Top", "Centre Y", "Bottom"].map((text, index) => `<button data-align="${index}">${text}</button>`).join("")}</div><div class="group-actions"><button data-distribute="0">Distribute X</button><button data-distribute="1">Distribute Y</button></div></section>`;
  if (items.length > 1) {
    element("inspector").innerHTML =
      `<p class="hint">Move the selection on the canvas, align it here, or group it. Resize one layer at a time.</p>${alignTools}`;
    return;
  }
  const item = items[0];
  let content = `<section class="property-section">${input("Layer name", "name", item.name, "text")}<label><input data-field="visible" type="checkbox"${item.visible ? " checked" : ""}/> Visible in exported HUD</label></section>`;
  const dimensions =
    item.kind === "text"
      ? ["Area X", "Area Y", "Area width", "Area height"]
      : ["X", "Y", "Width", "Height"];
  content += `<section class="property-section"><h3>Layout · native HUD units</h3><div class="field-grid">${dimensions.map((label, index) => input(label, `rect.${index}`, item.rect[index])).join("")}</div>${item.kind === "text" ? '<p class="hint">Canvas handles scale the lettering. These area values control native text alignment and wrapping.</p>' : ""}${select(
    "Horizontal anchor",
    "rect.4",
    item.rect[4],
    anchorsX.map((name, index) => [index, name]),
  )}${select(
    "Vertical anchor",
    "rect.5",
    item.rect[5],
    anchorsY.map((name, index) => [index, name]),
  )}<p class="hint">Anchor changes keep the current preview position. Other resolutions show the new anchoring.</p></section>`;
  if (item.kind === "text") {
    const alignments = [
      [0, "Baseline · left"],
      [1, "Baseline · centre"],
      [2, "Baseline · right"],
      [4, "Top · left"],
      [5, "Top · centre"],
      [6, "Top · right"],
      [8, "Middle · left"],
      [9, "Middle · centre"],
      [10, "Middle · right"],
      [12, "Bottom · left"],
      [13, "Bottom · centre"],
      [14, "Bottom · right"],
    ];
    content += `<section class="property-section"><h3>Text</h3><label class="field">Content<textarea data-field="text" maxlength="1020" spellcheck="false">${escape(item.text)}</textarea></label><button id="import-text" class="wide">Import text file…</button>${select(
      "Stock font",
      "font",
      item.font,
      fonts.map((name, index) => [index, name]),
    )}<button id="browse-fonts" class="wide">Browse font samples</button>${input("Font scale", "scale", item.scale)}${select("Text alignment", "align", item.align, alignments)}<div class="field-grid">${input("Text offset X", "offset.0", item.offset[0])}${input("Text offset Y", "offset.1", item.offset[1])}</div>${select(
      "Text style",
      "textStyle",
      item.textStyle,
      [
        [0, "Normal"],
        [3, "Shadow"],
        [6, "Stronger shadow"],
        [128, "Monospace"],
      ],
    )}<label><input type="checkbox" data-field="wrap"${item.wrap ? " checked" : ""}/> Wrap at word boundaries</label><p class="hint">Colour codes ^0–^7 are supported. ^7 restores the text colour. Long words can exceed the box.</p>${colour("Text colour", "foreground", item.foreground)}</section>`;
  } else if (item.kind === "image") {
    const local = item.localImage?.path;
    const value = local
      ? resources.localImages.get(local)
      : resources.materials.get(item.material);
    const detail = local
      ? `<p class="asset-detail">${escape(local)}</p><p class="hint">Design preview only. Convert this image in Asset Manager, then assign its converted material before exporting.</p><button id="replace-local" class="wide">Choose another local image…</button>`
      : `<p class="asset-detail">${escape(item.material || "No material selected")}</p>`;
    const source =
      value && !local
        ? `<div class="asset-detail">Image: ${escape(value.image)}<br>${value.levels[0].width} × ${value.levels[0].height} · ${escape(value.blend)}<br>Material: ${escape(value.source)}<br>Image source: ${escape(value.imageSource)}</div>`
        : "";
    const issue = local
      ? resources.localErrors.get(local)
      : resources.errors.get(item.material);
    content += `<section class="property-section"><h3>${local ? "Local image" : "Converted material"}</h3>${detail}<button id="change-material" class="wide">${local ? "Assign converted material…" : "Choose material…"}</button>${source}${value ? '<button id="native-size" class="wide">Use image dimensions</button>' : `<p class="error hint">${escape(issue || (local ? "Loading local reference…" : "Choose a supported converted 2D material."))}</p>`}<div class="check-row"><label><input data-flip="2" type="checkbox"${number(item.rect[2]) < 0 ? " checked" : ""}/> Flip X</label><label><input data-flip="3" type="checkbox"${number(item.rect[3]) < 0 ? " checked" : ""}/> Flip Y</label></div>${colour("Image tint", "foreground", item.foreground)}</section>`;
  } else {
    content += `<section class="property-section"><h3>Rectangle</h3>${colour("Fill colour", "fill", item.fill)}</section>`;
  }
  content += `<section class="property-section"><h3>Border</h3>${select(
    "Edges",
    "border",
    item.border,
    [
      [0, "None"],
      [1, "Full border"],
      [2, "Top and bottom"],
      [3, "Left and right"],
      [5, "Raised"],
      [6, "Sunken"],
    ],
  )}${item.border ? `${input("Thickness", "thickness", item.thickness)}${colour("Border colour", "borderColor", item.borderColor)}` : ""}</section>${alignTools}`;
  element("inspector").innerHTML = content;
}

function updateProperty(target, preview = false) {
  const items = selected();
  if (items.length !== 1) {
    return;
  }
  const snapshot = structuredClone(project);
  const item = items[0];
  try {
    if (target.dataset.colour) {
      const field = target.dataset.colour;
      item[field].splice(
        0,
        3,
        ...[1, 3, 5].map((at) =>
          token(parseInt(target.value.slice(at, at + 2), 16) / 255),
        ),
      );
    } else if (target.dataset.alpha) {
      item[target.dataset.alpha][3] = token(Number(target.value) / 100);
    } else if (target.dataset.flip) {
      const index = Number(target.dataset.flip);
      item.rect[index] = token(
        Math.abs(number(item.rect[index])) * (target.checked ? -1 : 1),
      );
    } else {
      const path = target.dataset.field.split(".");
      let value = target.value;
      if (target.type === "checkbox") {
        value = target.checked;
      } else if (target.type === "number") {
        if (value.trim() === "") {
          throw new Error("Enter a numeric value.");
        }
        value = token(value);
      } else if (target.tagName === "SELECT") {
        value = Number(value);
      }
      const oldBounds = bounds(item, project.viewport);
      if (path.length === 2) {
        item[path[0]][Number(path[1])] = value;
        if (path[0] === "rect" && Number(path[1]) >= 4) {
          setBounds(item, oldBounds, project.viewport);
        }
      } else {
        item[path[0]] = value;
      }
    }
    if (preview) {
      project = validateProject(project);
      element("project-name").textContent = project.name + " *";
      workspace.draw();
    } else {
      changed();
      message("Layout updated.");
    }
    return true;
  } catch (error) {
    project = snapshot;
    if (!preview) {
      changed(false);
    }
    message(error.message, true);
    return false;
  }
}

function removeSelection() {
  project.items = project.items.filter(
    (item) => !selection.has(item.id) || item.locked,
  );
  selection.clear();
  changed();
}

function paste() {
  if (project.items.length + clipboard.length > 256) {
    throw new Error("Pasting would exceed the 256-item host limit.");
  }
  const ids = new Set();
  const groups = new Map();
  for (const original of clipboard) {
    const item = structuredClone(original);
    item.id = crypto.randomUUID();
    item.name = createItem(item.kind, project.items).name;
    item.rect[0] = token(number(item.rect[0]) + 8);
    item.rect[1] = token(number(item.rect[1]) + 8);
    if (item.group) {
      if (!groups.has(item.group)) {
        groups.set(
          item.group,
          `group_${crypto.randomUUID().replaceAll("-", "")}`,
        );
      }
      item.group = groups.get(item.group);
    }
    project.items.push(item);
    ids.add(item.id);
  }
  selection = ids;
  changed();
}

function alignLayers(mode) {
  const items = selected().filter((item) => !item.locked);
  if (!items.length) {
    return;
  }
  const boxes = items.map((item) =>
    visualBounds(item, project.viewport, resources.fonts),
  );
  let left = Math.min(...boxes.map((box) => box[0]));
  let top = Math.min(...boxes.map((box) => box[1]));
  let right = Math.max(...boxes.map((box) => box[0] + box[2]));
  let bottom = Math.max(...boxes.map((box) => box[1] + box[3]));
  if (element("align-target").value === "artboard") {
    [left, top, right, bottom] = [
      0,
      0,
      project.viewport.width,
      project.viewport.height,
    ];
  }
  items.forEach((item, index) => {
    const box = boxes[index];
    if (mode === 0) {
      box[0] = left;
    }
    if (mode === 1) {
      box[0] = (left + right - box[2]) / 2;
    }
    if (mode === 2) {
      box[0] = right - box[2];
    }
    if (mode === 3) {
      box[1] = top;
    }
    if (mode === 4) {
      box[1] = (top + bottom - box[3]) / 2;
    }
    if (mode === 5) {
      box[1] = bottom - box[3];
    }
    moveVisualTo(item, box, project.viewport, resources.fonts);
  });
  changed();
}

function distribute(axis) {
  const items = selected()
    .filter((item) => !item.locked)
    .sort(
      (a, b) =>
        visualBounds(a, project.viewport, resources.fonts)[axis] -
        visualBounds(b, project.viewport, resources.fonts)[axis],
    );
  if (items.length < 3) {
    message("Select at least three unlocked layers to distribute.", true);
    return;
  }
  const boxes = items.map((item) =>
    visualBounds(item, project.viewport, resources.fonts),
  );
  const first = boxes[0][axis];
  const end = boxes.at(-1)[axis] + boxes.at(-1)[axis + 2];
  const total = boxes.reduce((sum, box) => sum + box[axis + 2], 0);
  const gap = (end - first - total) / (items.length - 1);
  let cursor = first;
  items.forEach((item, index) => {
    boxes[index][axis] = cursor;
    moveVisualTo(item, boxes[index], project.viewport, resources.fonts);
    cursor += boxes[index][axis + 2] + gap;
  });
  changed();
}

function bind(id, work) {
  element(id).addEventListener("click", () => action(work));
}

bind("new", async () => {
  if (await canDiscard()) {
    project = createProject();
    selection.clear();
    history = new History(project);
    saved = JSON.stringify(project);
    projectPath = null;
    changed(false);
    syncResolution();
    workspace.fit();
    message("New HUD.");
  }
});
bind("open", async () => {
  if (!desktop || !(await canDiscard())) {
    return;
  }
  const path = await open({
    title: "Open HUD project",
    filters: [{ name: "HUD project", extensions: ["wawhud"] }],
    multiple: false,
  });
  if (path) {
    const next = validateProject(
      JSON.parse(await invoke("read_project", { path })),
    );
    project = next;
    projectPath = path;
    selection.clear();
    history = new History(project);
    saved = JSON.stringify(project);
    await loadAssets();
    changed(false);
    syncResolution();
    workspace.fit();
  }
});
bind("save", () => saveProject());
bind("save-as", () => saveProject(true));
bind("add-text", () => add("text"));
bind("add-rectangle", () => add("rectangle"));
bind("add-image", () => {
  assetTray.open("materials");
});
bind("reload-assets", async () => {
  if (assetTray.mode === "local") {
    await assetTray.local.refresh();
    localMedia.retry(project);
    return;
  }
  await assetTray.scan(true);
  await loadAssets();
});
bind("clear-asset-cache", async () => {
  await assetTray.clear();
  message(
    "Asset cache cleared. Click Rescan to load the tray again. Your HUD is unchanged.",
  );
});
bind("undo", () => {
  workspace.cancel();
  project = history.step(-1);
  syncResolution();
  changed(false);
});
bind("redo", () => {
  workspace.cancel();
  project = history.step(1);
  syncResolution();
  changed(false);
});
bind("delete", removeSelection);
bind("duplicate", () => {
  clipboard = structuredClone(selected());
  paste();
});
bind("group", () => {
  const state = groupState();
  if (!state.canGroup) {
    return;
  }
  const group = `group_${crypto.randomUUID().replaceAll("-", "")}`;
  for (const item of state.items) {
    item.group = group;
  }
  changed();
});
bind("ungroup", () => {
  const state = groupState();
  if (!state.canUngroup) {
    return;
  }
  for (const item of state.items) {
    item.group = "";
  }
  changed();
});
for (const [id, direction] of [
  ["layer-up", 1],
  ["layer-down", -1],
]) {
  bind(id, () => {
    const indexes = project.items
      .map((item, index) => (selection.has(item.id) ? index : -1))
      .filter((index) => index >= 0);
    if (direction === 1) {
      indexes.reverse();
    }
    for (const index of indexes) {
      const other = index + direction;
      if (
        other >= 0 &&
        other < project.items.length &&
        !selection.has(project.items[other].id)
      ) {
        [project.items[index], project.items[other]] = [
          project.items[other],
          project.items[index],
        ];
      }
    }
    changed();
  });
}
bind("fit", () => workspace.fit());
function updateBackground() {
  const background = project.background;
  const picture = background && resources.localImages?.get(background.path);
  const size = picture?.levels[0];
  const issue = background && resources.localErrors?.get(background.path);
  element("background-info").textContent = background
    ? filename(background.path) +
      (size ? ` · ${size.width} × ${size.height}` : "") +
      "\n" +
      background.path +
      (issue ? "\n" + issue : "")
    : "No background selected.";
  element("background-info").classList.toggle("error", Boolean(issue));
  element("background-visible").checked = background?.visible !== false;
  element("background-opacity").value = Math.round(
    (background?.opacity ?? 1) * 100,
  );
  element("background-percent").textContent =
    element("background-opacity").value + "%";
  for (const id of [
    "background-visible",
    "background-opacity",
    "background-remove",
  ]) {
    element(id).disabled = !background;
  }
  element("background-size").disabled =
    !size ||
    size.width < 320 ||
    size.height < 320 ||
    size.width > 7680 ||
    size.height > 7680;
}

bind("background", () => {
  updateBackground();
  element("background-dialog").showModal();
});
bind("background-choose", async () => {
  if (!desktop) {
    throw new Error("Use the desktop app to select a local background image.");
  }
  const path = await open({
    title: "Choose canvas background",
    filters: imageFilters,
    multiple: false,
    defaultPath: project.background?.path,
  });
  if (path) {
    try {
      await localMedia.load(path);
    } catch (error) {
      element("background-info").textContent = String(error.message || error);
      element("background-info").classList.add("error");
      throw error;
    }
    project.background = { path, visible: true, opacity: 1 };
    changed();
    message("Canvas reference added. It will not be exported to the game.");
  }
});
bind("background-remove", () => {
  project.background = null;
  changed();
});
bind("background-size", () => {
  const size = resources.localImages.get(project.background.path).levels[0];
  project.viewport = { width: size.width, height: size.height };
  changed();
  syncResolution();
  workspace.fit();
});
element("background-visible").addEventListener("change", (event) => {
  if (project.background) {
    project.background.visible = event.target.checked;
    changed();
  }
});
element("background-opacity").addEventListener("input", (event) => {
  if (project.background) {
    project.background.opacity = Number(event.target.value) / 100;
    element("background-percent").textContent = event.target.value + "%";
    workspace.draw();
  }
});
element("background-opacity").addEventListener("change", () => changed());

bind("actual-size", () => {
  workspace.fitted = false;
  workspace.frame.scale = 1;
  workspace.draw();
});
element("grid").addEventListener("change", (event) => {
  workspace.grid = event.target.checked;
  workspace.draw();
});
element("snap").addEventListener("change", (event) => {
  workspace.snap = event.target.checked;
});
element("snap-size").addEventListener("change", (event) => {
  workspace.snapSize = Number(event.target.value);
  workspace.draw();
});

function syncResolution() {
  const value = `${project.viewport.width},${project.viewport.height}`;
  element("resolution").value = ["1280,720", "640,480", "1920,1080"].includes(
    value,
  )
    ? value
    : "custom";
}

element("resolution").addEventListener("change", (event) => {
  if (event.target.value === "custom") {
    element("preview-width").value = project.viewport.width;
    element("preview-height").value = project.viewport.height;
    element("resolution-dialog").showModal();
  } else {
    const [width, height] = event.target.value.split(",").map(Number);
    project.viewport = { width, height };
    changed();
    workspace.fit();
  }
});
element("resolution-form").addEventListener("submit", (event) => {
  event.preventDefault();
  project.viewport = {
    width: Number(element("preview-width").value),
    height: Number(element("preview-height").value),
  };
  changed();
  element("resolution-dialog").close();
  syncResolution();
  workspace.fit();
});

// Live text preview, with one history entry when the field is committed.
element("inspector").addEventListener("input", (event) => {
  if (
    event.target.matches('textarea[data-field="text"]') &&
    selected().length === 1
  ) {
    selected()[0].text = event.target.value;
    element("project-name").textContent = `${project.name} *`;
    workspace.draw();
  }
});
element("inspector").addEventListener(
  "wheel",
  (event) => {
    if (
      event.target.matches('input[type="number"]') &&
      document.activeElement === event.target
    ) {
      event.target.blur();
    }
  },
  { passive: true },
);
element("inspector").addEventListener("change", (event) => {
  if (
    event.target.matches(
      "[data-field], [data-colour], [data-alpha], [data-flip]",
    )
  ) {
    updateProperty(event.target);
  }
});
element("inspector").addEventListener("click", (event) =>
  action(async () => {
    const target = event.target.closest("button");
    if (!target) {
      return;
    }
    if (target.dataset.align !== undefined) {
      alignLayers(Number(target.dataset.align));
    }
    if (target.dataset.distribute !== undefined) {
      distribute(Number(target.dataset.distribute));
    }
    const item = selected()[0];
    if (target.id === "change-material") {
      assetTray.open("materials", item.id);
    } else if (target.id === "browse-fonts") {
      assetTray.open("fonts");
    } else if (target.id === "replace-local") {
      assetTray.open("local", item.id);
      if (item.localImage) {
        await assetTray.local.navigate(item.localImage.path);
      }
    } else if (target.id === "native-size") {
      const picture = item.localImage
        ? resources.localImages.get(item.localImage.path)
        : resources.materials.get(item.material);
      if (!picture) {
        return;
      }
      const value = picture.levels[0];
      item.rect[2] = token(value.width);
      item.rect[3] = token(value.height);
      changed();
    } else if (target.id === "import-text") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".txt";
      input.onchange = async () => {
        const file = input.files[0];
        if (file?.size > 8192) {
          message("Text file exceeds the 1,020-character HUD limit.", true);
          return;
        }
        if (file) {
          const text = await file.text();
          if (text.length > 1020) {
            message("Text exceeds 1,020 characters.", true);
            return;
          }
          item.text = text;
          changed();
        }
      };
      input.click();
    }
  }),
);

const modExport = new ModExport({
  source: () => exportInc(project, resources),
  project: () => project,
  desktop,
  message,
  resolve: (id) => {
    element("export-dialog").close();
    choose(new Set([id]));
    assetTray.open("materials", id);
  },
});
bind("export", () => modExport.open());
bind("copy-source", () =>
  modExport.work(async () => {
    await navigator.clipboard.writeText(exportInc(project, resources));
    element("export-code-status").textContent = "HUD code copied.";
    message("INC source copied.");
  }),
);
bind("copy-materials", () =>
  modExport.work(async () => {
    await navigator.clipboard.writeText(
      element("export-materials").textContent,
    );
    element("export-code-status").textContent = "Material entries copied.";
    message("Material entries copied.");
  }),
);
bind("save-export", () =>
  modExport.work(async () => {
    if (!desktop) {
      throw new Error("Open the desktop app to save an .inc file.");
    }
    const path = await save({
      title: "Export HUD include",
      defaultPath: `${project.name.replace(/[^A-Za-z0-9_-]/g, "_")}.inc`,
      filters: [{ name: "HUD include", extensions: ["inc"] }],
    });
    if (path && (await write(path, exportInc(project, resources)))) {
      element("export-code-status").textContent = `INC exported: ${path}`;
      message(`INC exported: ${path}`);
    }
  }),
);
bind("about", () => {
  element("about-dialog").showModal();
  element("repo-url").focus();
  element("repo-url").select();
});
element("repo-url").addEventListener("click", (event) => event.target.select());
for (const button of document.querySelectorAll("[data-close]")) {
  button.addEventListener("click", () => element(button.dataset.close).close());
}

window.addEventListener("keydown", (event) => {
  if (layerList?.interacting || numberScrubber?.active) {
    event.preventDefault();
    return;
  }
  if (
    !workspace ||
    element("app").hidden ||
    document.querySelector("dialog[open]")
  ) {
    return;
  }
  const control = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (control && ["s", "o", "n"].includes(key)) {
    event.preventDefault();
    document.activeElement?.blur();
    const id = { s: event.shiftKey ? "save-as" : "save", o: "open", n: "new" }[
      key
    ];
    element(id).click();
    return;
  }
  if (
    document.activeElement?.matches("input, textarea, select") ||
    workspace.drag
  ) {
    return;
  }
  if (control && ["s", "o", "n", "z", "y", "d"].includes(key)) {
    event.preventDefault();
    const id = {
      s: event.shiftKey ? "save-as" : "save",
      o: "open",
      n: "new",
      z: event.shiftKey ? "redo" : "undo",
      y: "redo",
      d: "duplicate",
    }[key];
    element(id).click();
  } else if (control && key === "a") {
    event.preventDefault();
    choose(
      new Set(
        project.items.filter((item) => !item.locked).map((item) => item.id),
      ),
    );
  } else if (control && key === "c") {
    clipboard = structuredClone(selected());
    event.preventDefault();
  } else if (control && key === "v") {
    event.preventDefault();
    action(paste);
  } else if (event.key === "Delete") {
    event.preventDefault();
    action(removeSelection);
  } else if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
  ) {
    event.preventDefault();
    const axis = ["ArrowLeft", "ArrowRight"].includes(event.key) ? 0 : 1;
    const sign = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
    for (const item of selected().filter((entry) => !entry.locked)) {
      item.rect[axis] = token(
        number(item.rect[axis]) + sign * (event.shiftKey ? 10 : 1),
      );
    }
    changed();
  }
});

async function start() {
  document.querySelectorAll("[data-version]").forEach((target) => {
    target.textContent = version;
  });
  if (desktop) {
    try {
      const context = await invoke("startup");
      element("environment").textContent = context.development
        ? "Development"
        : "Production";
    } catch (error) {
      element("placement-message").textContent = String(error);
      element("placement").hidden = false;
      element("environment").textContent = import.meta.env.DEV
        ? "Development"
        : "Production";
      element("status").textContent = "Needs attention";
      return;
    }
  }
  element("app").hidden = false;
  layerList = new LayerList(element("layers"), {
    items: () => project.items,
    selection: () => selection,
    select: choose,
    toggle: (id, field) => {
      const item = project.items.find((item) => item.id === id);
      if (item) {
        item[field] = !item[field];
        changed();
      }
    },
    reorder: (order) => {
      const items = new Map(project.items.map((item) => [item.id, item]));
      if (
        order.length !== items.size ||
        new Set(order).size !== items.size ||
        order.some((id) => !items.has(id))
      ) {
        return;
      }
      const next = [...order].reverse().map((id) => items.get(id));
      if (next.every((item, index) => item.id === project.items[index].id)) {
        return;
      }
      project.items = next;
      changed();
    },
    rename: (id, value) => {
      const item = project.items.find((item) => item.id === id);
      if (!item || item.name === value) {
        return;
      }
      if (
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ||
        project.items.some((other) => other.id !== id && other.name === value)
      ) {
        throw new Error(
          "Use a unique layer name: start with a letter or underscore, then use letters, numbers or underscores (up to 64 characters).",
        );
      }
      item.name = value;
      changed();
      message("Layer renamed.");
    },
    error: (text) => message(text, true),
  });
  numberScrubber = new NumberScrubber(element("inspector"), {
    begin: () => structuredClone(project),
    preview: (input) => updateProperty(input, true),
    commit: () => {
      changed();
      message("Layout updated.");
    },
    cancel: (snapshot) => {
      project = snapshot;
      changed(false);
    },
  });
  workspace = new Workspace(
    element("workspace"),
    {
      project: () => project,
      selection: () => selection,
      select: choose,
      commit: () => changed(),
      restore: (snapshot) => {
        project = snapshot;
        changed(false);
      },
      preview: () => {
        element("project-name").textContent = `${project.name} *`;
        const item = selected()[0];
        if (item) {
          for (let index = 0; index < 4; index += 1) {
            const input = document.querySelector(
              `[data-field="rect.${index}"]`,
            );
            if (input && document.activeElement !== input) {
              input.value = item.rect[index];
            }
          }
          for (const path of ["scale", "offset.0", "offset.1", "thickness"]) {
            const input = document.querySelector(`[data-field="${path}"]`);
            if (input && document.activeElement !== input) {
              input.value = path
                .split(".")
                .reduce((value, key) => value[key], item);
            }
          }
        }
      },
      position: ([x, y]) => {
        element("cursor-position").textContent =
          `${Math.round(x)}, ${Math.round(y)} px`;
      },
      zoom: (scale) => {
        element("zoom").textContent = `${Math.round(scale * 100)}%`;
      },
    },
    resources,
  );
  localMedia = new LocalMedia(resources, workspace.renderer, () => {
    renderInspector();
    updateBackground();
    workspace.draw();
  });
  assetTray = new AssetTray(resources, {
    choose: (kind, name, target, clientPoint = null) => {
      // Capture the position before an asynchronous texture load: later viewport
      // movement must not change where this drop occurred in the HUD.
      const point = clientPoint ? workspace.point(clientPoint) : null;
      return action(async () => {
        if (kind === "local") {
          const value = await localMedia.load(name);
          const item = target
            ? project.items.find((entry) => entry.id === target)
            : null;
          if (target && !item) {
            localMedia.sync(project);
            throw new Error(
              "That layer was removed. Choose a layer before replacing its image.",
            );
          }
          if (item) {
            item.material = "";
            item.localImage = { path: name };
            changed();
          } else {
            add("image", { ...value, localPath: name }, point);
          }
        } else if (kind === "materials") {
          const value = await material(name);
          const item = target
            ? project.items.find((entry) => entry.id === target)
            : null;
          if (target && !item) {
            throw new Error(
              "That layer was removed. Choose a layer before replacing its material.",
            );
          }
          if (item) {
            item.material = value.name;
            delete item.localImage;
            changed();
          } else {
            add("image", value, point);
          }
        } else {
          const settings = {
            normalFont: [1, null],
            bigFont: [2, null],
            smallFont: [3, null],
            consoleFont: [5, null],
            objectiveFont: [6, null],
            boldFont: [4, 0.4],
            extraBigFont: [0, 0.55],
          }[name];
          let items = point
            ? []
            : selected().filter((item) => item.kind === "text");
          if (!items.length) {
            if (project.items.length >= 256) {
              throw new Error(
                "The HUD item limit is 256. Remove a layer before adding text.",
              );
            }
            const item = createItem("text", project.items);
            project.items.push(item);
            selection = new Set([item.id]);
            items = [item];
          }
          for (const item of items) {
            item.font = settings[0];
            if (settings[1] !== null) {
              // Adaptive font selection uses the resolved viewport scale. Make
              // the chosen physical font visible now without inventing an INC ID.
              const minimum =
                (settings[1] + 0.000001) /
                axis(project.viewport, item.rect[5], false).scale;
              item.scale = token(Math.max(number(item.scale), minimum));
            }
            if (point) {
              placeItem(item, point);
            }
          }
          changed();
        }
      });
    },
  });
  changed(false);
  requestAnimationFrame(() => workspace.fit());
  if (desktop) {
    await getCurrentWindow().onCloseRequested(async (event) => {
      layerList.cancel();
      numberScrubber.finish(false);
      if (modExport.running) {
        event.preventDefault();
        message("Wait for the mod export to finish before closing the editor.");
        return;
      }
      if (JSON.stringify(project) !== saved) {
        event.preventDefault();
        if (!busy && (await canDiscard())) {
          await getCurrentWindow().destroy();
        }
      }
    });
    element("status").textContent = "Loading fonts…";
    try {
      await loadAssets();
    } catch (error) {
      message(String(error.message || error), true);
    }
    void assetTray.scan().catch((error) => {
      message(String(error.message || error), true);
    });
  } else {
    assetTray.previewOnly();
    message(
      "Browser UI preview. Use npm run dev for stock fonts, converted materials and native file dialogs.",
    );
    element("status").textContent = "Ready";
  }
}

start().catch((error) => {
  if (!element("app").hidden) {
    message(String(error.message || error), true);
  } else {
    element("placement-message").textContent = String(error.message || error);
    element("placement").hidden = false;
  }
});
