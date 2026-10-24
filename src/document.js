// Numeric source tokens are retained: preview and export interpret the same
// decimal, including the original parser's unusual rounding at boundaries.
export function token(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > 1000000) {
    throw new Error("Enter a finite value between -1,000,000 and 1,000,000.");
  }
  const text = number.toFixed(9).replace(/\.?0+$/, "");
  return text === "-0" || text === "" ? "0" : text;
}

export function number(value) {
  const text = String(value);
  let result = 0;
  let divisor = 0;
  for (const character of text.replace(/^-/, "")) {
    if (character === ".") {
      divisor = 10;
    } else if (divisor !== 0) {
      result += Number(character) / divisor;
      divisor *= 10;
    } else {
      result = result * 10 + Number(character);
    }
  }
  if (text.startsWith("-")) {
    result = -result;
  }
  return Math.fround(result);
}

export function rgba(value) {
  return value.map(number);
}

export function createProject() {
  return {
    format: "waw-hud",
    version: 1,
    name: "Untitled HUD",
    items: [],
    background: null,
    viewport: { width: 1280, height: 720 },
  };
}

export function createItem(kind, items) {
  let index = 1;
  while (items.some((item) => item.name === `${kind}_${index}`)) {
    index += 1;
  }
  return {
    id: crypto.randomUUID(),
    name: `${kind}_${index}`,
    kind,
    rect: [
      "32",
      "32",
      kind === "text" ? "220" : "120",
      kind === "text" ? "40" : "80",
      1,
      1,
    ],
    text: kind === "text" ? "Your text" : "",
    font: 1,
    scale: "0.375",
    align: 4,
    offset: ["0", "0"],
    textStyle: 0,
    wrap: false,
    foreground: ["1", "1", "1", "1"],
    fill: ["0.1", "0.2", "0.3", "0.75"],
    border: 0,
    thickness: "1",
    borderColor: ["1", "1", "1", "1"],
    material: "",
    visible: true,
    hidden: false,
    locked: false,
    group: "",
  };
}

export function validateProject(input) {
  if (
    input?.format !== "waw-hud" ||
    input.version !== 1 ||
    !Array.isArray(input.items) ||
    input.items.length > 256
  ) {
    throw new Error(
      "This is not a supported WaW HUD project (maximum 256 items).",
    );
  }
  const project = createProject();
  project.name = String(input.name || "Untitled HUD").slice(0, 120);
  for (const axis of ["width", "height"]) {
    const value = Number(input.viewport?.[axis]);
    if (!Number.isInteger(value) || value < 320 || value > 7680) {
      throw new Error(
        "Preview resolution must be between 320 and 7680 pixels.",
      );
    }
    project.viewport[axis] = value;
  }
  // Local paths are editor references only. Pixels are never embedded in projects.
  const reference = (raw) => {
    if (
      typeof raw?.path !== "string" ||
      !raw.path ||
      raw.path.length > 4096 ||
      raw.path.includes("\0")
    ) {
      throw new Error("Invalid local image reference.");
    }
    return { path: raw.path };
  };
  if (input.background) {
    project.background = reference(input.background);
    project.background.visible = input.background.visible !== false;
    const opacity = Number(input.background.opacity ?? 1);
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
      throw new Error("Background opacity must be between 0 and 1.");
    }
    project.background.opacity = opacity;
  }
  const names = new Set();
  const ids = new Set();
  for (const raw of input.items) {
    if (
      !["text", "image", "rectangle"].includes(raw.kind) ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(raw.name) ||
      names.has(raw.name)
    ) {
      throw new Error(
        "Every layer needs a unique name using letters, numbers and underscores.",
      );
    }
    if (typeof raw.id !== "string" || ids.has(raw.id)) {
      throw new Error("Project contains missing or duplicate layer IDs.");
    }
    const item = createItem(raw.kind, []);
    for (const key of ["id", "name", "text", "material", "group"]) {
      item[key] = String(raw[key] ?? "");
    }
    if (raw.localImage) {
      if (raw.kind !== "image" || item.material) {
        throw new Error(
          "A local image layer cannot also have a converted material.",
        );
      }
      item.localImage = reference(raw.localImage);
    }
    if (
      item.text.length > 1020 ||
      item.material.length > 256 ||
      item.group.length > 64
    ) {
      throw new Error(`${item.name}: text or asset name is too long.`);
    }
    if (
      !Array.isArray(raw.rect) ||
      raw.rect.length !== 6 ||
      !Array.isArray(raw.offset) ||
      raw.offset.length !== 2
    ) {
      throw new Error(`${item.name}: invalid layout values.`);
    }
    item.rect = raw.rect.slice(0, 4).map(token);
    for (const anchor of raw.rect.slice(4)) {
      if (!Number.isInteger(anchor) || anchor < 0 || anchor > 7) {
        throw new Error(`${item.name}: invalid anchor.`);
      }
      item.rect.push(anchor);
    }
    item.offset = raw.offset.map(token);
    for (const key of ["scale", "thickness"]) {
      item[key] = token(raw[key]);
      if (number(item[key]) < 0) {
        throw new Error(`${item.name}: ${key} cannot be negative.`);
      }
    }
    for (const key of ["foreground", "fill", "borderColor"]) {
      if (!Array.isArray(raw[key]) || raw[key].length !== 4) {
        throw new Error(`${item.name}: invalid colour.`);
      }
      item[key] = raw[key].map(token);
      if (rgba(item[key]).some((value) => value < 0 || value > 1)) {
        throw new Error(`${item.name}: colours must be between 0 and 1.`);
      }
    }
    const options = {
      font: [0, 1, 2, 3, 4, 5, 6],
      align: [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14],
      textStyle: [0, 3, 6, 128],
      border: [0, 1, 2, 3, 5, 6],
    };
    for (const [key, values] of Object.entries(options)) {
      if (!values.includes(raw[key])) {
        throw new Error(`${item.name}: unsupported ${key}.`);
      }
      item[key] = raw[key];
    }
    for (const key of ["visible", "hidden", "locked", "wrap"]) {
      item[key] = Boolean(raw[key]);
    }
    names.add(item.name);
    ids.add(item.id);
    project.items.push(item);
  }
  return project;
}

export function nativeString(text) {
  const tokens = [];
  let pending = "";
  for (const character of text) {
    const value = character.codePointAt(0);
    if (value === 47 || value >= 128) {
      if (value > 255) {
        throw new Error(`Unsupported stock-font character: ${character}`);
      }
      if (pending) {
        tokens.push(`"${pending}"`);
        pending = "";
      }
      tokens.push(`"\\x${value.toString(16).toUpperCase().padStart(2, "0")}"`);
    } else if ([9, 10, 13, 34, 92].includes(value)) {
      pending += { 9: "\\t", 10: "\\n", 13: "\\r", 34: '\\"', 92: "\\\\" }[
        value
      ];
    } else {
      if (value < 32 || value === 127) {
        throw new Error("Control/icon text is not supported in static text.");
      }
      pending += character;
    }
  }
  if (pending || tokens.length === 0) {
    tokens.push(`"${pending}"`);
  }
  return tokens.join(" ");
}

export function exportInc(project, resources) {
  const checked = validateProject(project);
  const unresolved = checked.items.filter((item) => item.localImage);
  if (unresolved.length) {
    throw new Error(
      "Assign converted materials before exporting: " +
        unresolved.map((item) => item.name).join(", "),
    );
  }
  const blocks = [
    "// Include these items inside your active HUD menuDef.",
    "// Baseline host: rect 0 0 640 480 0 0, with no host border.",
  ];
  for (const item of checked.items) {
    const fields = [
      `name "${item.name}"`,
      `rect ${item.rect.join(" ")}`,
      `visible ${item.visible ? 1 : 0}`,
      "decoration",
    ];
    if (item.kind === "text") {
      if (item.text.startsWith("@") || /\^[89]/.test(item.text)) {
        throw new Error(
          `${item.name}: localisation/contextual colours are outside static text.`,
        );
      }
      const font = resources.fontFor(item, project.viewport);
      if (!font) {
        throw new Error("Stock fonts have not loaded yet.");
      }
      if (!resources.materials.has(font.material)) {
        throw new Error(
          `${item.name}: the selected stock font atlas is unavailable. Reload assets to see the reason.`,
        );
      }
      for (const character of item.text
        .replace(/\^[0-7]/g, "")
        .replace(/[\r\n\t]/g, "")) {
        if (
          !font.glyphs.some(
            (glyph) => glyph.letter === character.codePointAt(0),
          )
        ) {
          throw new Error(
            `${item.name}: the selected stock font cannot display '${character}'.`,
          );
        }
      }
      fields.push(
        "type 1",
        `text ${nativeString(item.text)}`,
        `textfont ${item.font}`,
        `textscale ${item.scale}`,
        `textalign ${item.align}`,
        `textalignx ${item.offset[0]}`,
        `textaligny ${item.offset[1]}`,
        `textstyle ${item.textStyle}`,
        `forecolor ${item.foreground.join(" ")}`,
      );
      if (item.wrap) {
        fields.push("autowrapped");
      }
    } else if (item.kind === "image") {
      if (!resources.materials.has(item.material)) {
        throw new Error(
          `${item.name}: choose or reload its converted material first.`,
        );
      }
      if (
        !/^[A-Za-z0-9_/$.-]+$/.test(item.material) ||
        item.material.split("/").some((part) => part === ".." || part === ".")
      ) {
        throw new Error(`${item.name}: invalid material name.`);
      }
      fields.push(
        "style 3",
        `background "${item.material}"`,
        `forecolor ${item.foreground.join(" ")}`,
      );
    } else {
      fields.push("style 1", `backcolor ${item.fill.join(" ")}`);
    }
    if (item.border) {
      fields.push(
        `border ${item.border}`,
        `bordersize ${item.thickness}`,
        `bordercolor ${item.borderColor.join(" ")}`,
      );
    }
    if (item.group && /^[A-Za-z_][A-Za-z0-9_]*$/.test(item.group)) {
      fields.push(`group "${item.group}"`);
    }
    blocks.push(
      `itemDef\n{\n${fields.map((field) => `    ${field}`).join("\n")}\n}`,
    );
  }
  return blocks.join("\n\n") + "\n";
}

export class History {
  constructor(project) {
    this.reset(project);
  }

  reset(project) {
    this.entries = [JSON.stringify(project)];
    this.cursor = 0;
  }

  commit(project) {
    const text = JSON.stringify(project);
    if (text === this.entries[this.cursor]) {
      return;
    }
    this.entries.splice(this.cursor + 1);
    this.entries.push(text);
    if (this.entries.length > 150) {
      this.entries.shift();
    }
    this.cursor = this.entries.length - 1;
  }

  step(direction) {
    this.cursor = Math.max(
      0,
      Math.min(this.entries.length - 1, this.cursor + direction),
    );
    return JSON.parse(this.entries[this.cursor]);
  }
}
