import { invoke } from "@tauri-apps/api/core";
import { createItem, token } from "./document.js";
import { Renderer } from "./renderer.js";
import { LocalBrowser } from "./local-browser.js";

const element = (id) => document.getElementById(id);
const assetType = "application/x-waw-hud-asset";

// A single small renderer serves every thumbnail. Tiles keep only PNG previews,
// not a WebGL context or full decoded texture for each material.
export class AssetTray {
  constructor(resources, callbacks) {
    this.resources = resources;
    this.callbacks = callbacks;
    this.mode = "materials";
    this.names = [];
    this.examined = 0;
    this.state = "loading";
    this.cache = null;
    this.failed = new Map();
    this.cacheBusy = false;
    this.queue = [];
    this.tiles = new Map();
    this.running = false;
    this.target = null;
    this.tabs = {
      materials: { query: "", scroll: 0 },
      fonts: { query: "", scroll: 0 },
      local: { query: "", scroll: 0 },
    };
    this.local = new LocalBrowser({
      active: () => this.mode === "local",
      choose: (path) => {
        const target = this.target;
        this.target = null;
        this.callbacks.choose("local", path, target);
      },
    });
    this.previewResources = { fonts: [], materials: new Map() };
    this.canvas = document.createElement("canvas");
    this.canvas.className = "thumbnail-renderer";
    this.canvas.setAttribute("aria-hidden", "true");
    document.body.append(this.canvas);
    this.renderer = new Renderer(this.canvas, this.previewResources);
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.observer.unobserve(entry.target);
            if (entry.target.dataset.state === "new") {
              entry.target.dataset.state = "queued";
              this.queue.push(entry.target);
            }
          }
        }
        void this.drain();
      },
      { root: element("asset-list"), rootMargin: "80px" },
    );

    for (const mode of ["materials", "fonts", "local"]) {
      element(`${mode}-tab`).addEventListener("click", () => this.open(mode));
    }
    element("asset-search").addEventListener("input", () => {
      this.tabs[this.mode].query = element("asset-search").value;
      this.tabs[this.mode].scroll = 0;
      this.render();
    });
    element("asset-list").addEventListener("scroll", () => {
      if (!element("asset-tray").classList.contains("collapsed")) {
        this.tabs[this.mode].scroll = element("asset-list").scrollTop;
      }
    });
    element("toggle-assets").addEventListener("click", () => {
      if (!element("asset-tray").classList.contains("collapsed")) {
        this.tabs[this.mode].scroll = element("asset-list").scrollTop;
      }
      const collapsed = element("asset-tray").classList.toggle("collapsed");
      element("toggle-assets").textContent = collapsed
        ? "Show tray"
        : "Hide tray";
      element("toggle-assets").setAttribute(
        "aria-expanded",
        String(!collapsed),
      );
      if (collapsed) {
        this.target = null;
      } else {
        element("asset-list").scrollTop = this.tabs[this.mode].scroll;
      }
    });
    this.resize();
    this.enableDrop();
    this.render();
  }

  open(mode = "materials", target = null) {
    // The two tabs are separate browsers: changing tabs must not discard the
    // user's place or search, including when reopened from the inspector.
    if (!element("asset-tray").classList.contains("collapsed")) {
      this.tabs[this.mode].scroll = element("asset-list").scrollTop;
    }
    this.mode = mode;
    this.target = target;
    element("asset-tray").classList.remove("collapsed");
    element("toggle-assets").textContent = "Hide tray";
    element("toggle-assets").setAttribute("aria-expanded", "true");
    element("asset-search").value = this.tabs[mode].query;
    this.render();
    element("asset-search").focus();
  }

  async scan(force = false) {
    this.cacheBusy = true;
    this.state = "loading";
    this.names = [];
    this.tiles.clear();
    this.failed.clear();
    this.render();
    try {
      const catalogue = await invoke("scan_materials", { force });
      this.names = catalogue.names;
      this.examined = catalogue.examined;
      this.cache = catalogue.cache || null;
      this.state = "ready";
      for (const [key, error] of Object.entries(this.cache?.issues || {})) {
        this.failed.set(key, error);
      }
    } catch (error) {
      this.state = "error";
      this.cacheError = String(error.message || error);
      throw error;
    } finally {
      this.cacheBusy = false;
      this.render();
    }
  }

  async clear() {
    const previous = this.state;
    this.cacheBusy = true;
    this.state = "clearing";
    this.tiles.clear();
    this.queue = [];
    this.render();
    try {
      await invoke("clear_asset_cache");
      this.state = "cleared";
      this.names = [];
      this.examined = 0;
      this.failed.clear();
      // Retain resources used by the open HUD; only the asset browser empties.
      this.target = null;
    } catch (error) {
      this.state = previous;
      throw error;
    } finally {
      this.cacheBusy = false;
      this.render();
    }
  }

  previewOnly() {
    this.state = "preview";
    this.render();
  }

  cacheControls() {
    element("clear-asset-cache").hidden = this.mode === "local";
    element("reload-assets").textContent =
      this.mode === "local" ? "Refresh" : "Rescan";
    element("reload-assets").title =
      this.mode === "local"
        ? "Refresh this image folder and reload linked local images"
        : "Rescan after converting or installing assets";
    if (this.mode === "local") {
      element("reload-assets").disabled = this.local.loading;
      return;
    }
    const pending =
      this.cacheBusy || this.state === "loading" || this.state === "preview";
    element("reload-assets").disabled = pending;
    element("clear-asset-cache").disabled = pending;
  }

  cacheStatus() {
    const labels = {
      saved: "Saved catalogue",
      scanned: "Catalogue scanned and saved",
      session: "Session catalogue",
    };
    const status = element("asset-cache-status");
    if (this.state === "cleared") {
      status.textContent = "Cache deleted. Rescan creates a new catalogue.";
      status.title = "";
      return;
    }
    const mode = labels[this.cache?.mode] || "Asset catalogue";
    status.textContent =
      this.state === "ready"
        ? mode +
          " · " +
          this.failed.size +
          " unavailable preview(s) found so far. Rescan after asset changes."
        : "";
    status.title = [...this.failed.entries()]
      .slice(0, 25)
      .map(([name, error]) => name + ": " + error)
      .join("\n");
    if (this.cache?.warning && this.state === "ready") {
      status.textContent += " " + this.cache.warning;
    }
    element("clear-asset-cache").title = this.cache?.path
      ? "Delete saved catalogue: " + this.cache.path
      : "Delete this installation’s saved catalogue. Your HUD and game assets stay untouched.";
  }

  refreshFonts() {
    for (const key of this.failed.keys()) {
      if (key.startsWith("fonts:")) {
        this.failed.delete(key);
      }
    }
    for (const key of this.tiles.keys()) {
      if (key.startsWith("fonts:")) {
        this.tiles.delete(key);
      }
    }
    this.render();
  }

  render() {
    this.observer.disconnect();
    for (const tile of this.queue) {
      tile.dataset.state = "new";
    }
    this.queue = [];
    const list = element("asset-list");
    list.replaceChildren();
    for (const mode of ["materials", "fonts", "local"]) {
      element(mode + "-tab").setAttribute(
        "aria-pressed",
        String(mode === this.mode),
      );
    }
    list.hidden = this.mode === "local";
    element("local-browser").hidden = this.mode !== "local";
    if (this.mode === "local") {
      element("asset-search").placeholder = "Find a local image…";
      if (this.local.query !== element("asset-search").value) {
        this.local.scroll = 0;
      }
      this.local.query = element("asset-search").value;
      this.cacheControls();
      this.local.render();
      return;
    }
    const fonts = this.mode === "fonts";
    list.classList.toggle("font-list", fonts);
    element("materials-tab").setAttribute("aria-pressed", String(!fonts));
    element("fonts-tab").setAttribute("aria-pressed", String(fonts));
    element("asset-search").placeholder = fonts
      ? "Find a stock font…"
      : "Find a 2D material…";
    const query = element("asset-search").value.trim().toLowerCase();
    const names = fonts
      ? this.cache?.fontNames || this.resources.fonts.map((font) => font.name)
      : this.names;
    if (fonts && this.state === "ready") {
      for (const name of names) {
        if (!this.resources.fonts.some((font) => font.name === name)) {
          const key = `fonts:${name}`;
          this.failed.set(
            key,
            this.cache?.issues?.[key] ||
              "Font definition unavailable. Click Rescan.",
          );
        }
      }
    }
    const available = this.state === "ready" ? names : [];
    const filtered = available.filter(
      (name) =>
        name.toLowerCase().includes(query) &&
        !this.failed.has(`${this.mode}:${name}`),
    );
    element("asset-summary").textContent = fonts
      ? `${filtered.length} of ${names.length} stock fonts · Samples at source size. Click to apply/add text, or drag onto the HUD to add text. Some fonts share letter glyphs.`
      : `${filtered.length} of ${names.length} supported 2D materials · ${this.examined} material files checked. ${this.target ? "Click to replace the selected layer's material." : "Click to add, or drag onto the HUD."} Images are checked as previews load.`;
    if (this.state === "loading") {
      element("asset-summary").textContent =
        "Loading the saved catalogue, or scanning for the first time…";
    } else if (this.state === "clearing") {
      element("asset-summary").textContent = "Clearing the saved catalogue…";
    } else if (this.state === "preview") {
      element("asset-summary").textContent =
        "Browser preview. Use the desktop app to browse installed assets.";
    } else if (this.state === "cleared") {
      element("asset-summary").textContent =
        "Cache cleared. Click Rescan to load assets.";
    } else if (this.state === "error") {
      element("asset-summary").textContent = this.cacheError;
    }
    this.cacheControls();
    this.cacheStatus();
    for (const name of filtered) {
      const key = `${this.mode}:${name}`;
      let button = this.tiles.get(key);
      if (!button) {
        button = document.createElement("button");
        button.className = `asset-tile${fonts ? " font-tile" : ""}`;
        button.dataset.name = name;
        button.dataset.kind = this.mode;
        button.dataset.state = "new";
        button.disabled = true;
        button.title = name;
        const preview = document.createElement("img");
        preview.alt = "";
        preview.draggable = false;
        preview.hidden = true;
        const caption = document.createElement("span");
        caption.textContent = name;
        button.append(preview, caption);
        if (fonts) {
          const font = this.resources.fonts.find((font) => font.name === name);
          const note = document.createElement("small");
          note.className = "font-detail";
          note.textContent = `${font.height}px source size`;
          button.append(note);
          const reference = { boldFont: "normalFont", extraBigFont: "bigFont" }[
            name
          ];
          if (reference && this.sharedSample(font, reference)) {
            note.textContent += ` · same letters as ${reference}`;
            button.title += `\nThe sample letters share glyphs with ${reference}; adaptive font selection and HUD scale still affect their in-game use.`;
          }
        }
        button.addEventListener("dragstart", (event) => {
          if (button.disabled) {
            event.preventDefault();
            return;
          }
          this.target = null;
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(
            assetType,
            JSON.stringify({ kind: button.dataset.kind, name }),
          );
          event.dataTransfer.setDragImage(preview, 0, 0);
        });
        button.addEventListener("click", () => {
          const target = this.target;
          this.callbacks.choose(button.dataset.kind, name, target);
          this.target = null;
        });
        this.tiles.set(key, button);
      }
      list.append(button);
      if (button.dataset.state === "new") {
        this.observer.observe(button);
      }
    }
    if (!filtered.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      if (this.state === "loading") {
        hint.textContent = "Loading assets…";
      } else if (this.state === "clearing") {
        hint.textContent = "Stopping preview loads…";
      } else if (this.state === "preview") {
        hint.textContent = "Run npm run dev for game materials and fonts.";
      } else if (this.state === "cleared") {
        hint.textContent =
          "Click Rescan when you want to browse materials and fonts again.";
      } else if (this.state === "error") {
        hint.textContent =
          "Click Rescan to rebuild the catalogue, or Clear cache to remove it.";
      } else {
        hint.textContent = query
          ? "No matching assets."
          : "No usable assets in this view. Rescan after converting or changing assets.";
      }
      list.append(hint);
    }
    list.scrollTop = this.tabs[this.mode].scroll;
  }

  skip(kind, name, error) {
    const key = `${kind}:${name}`;
    this.failed.set(key, String(error.message || error));
    const tile = this.tiles.get(key);
    if (tile) {
      tile.dataset.state = "failed";
      tile.hidden = true;
    }
    this.cacheStatus();
  }

  async drain() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length) {
        const tile = this.queue.shift();
        if (!tile.isConnected) {
          tile.dataset.state = "new";
          continue;
        }
        const name = tile.dataset.name;
        const kind = tile.dataset.kind;
        const key = `${kind}:${name}`;
        tile.dataset.state = "loading";
        try {
          const asset =
            kind === "fonts"
              ? this.resources.fonts.find((font) => font.name === name)
              : await invoke("material_thumbnail", { name });
          if (this.tiles.get(key) !== tile) {
            continue;
          }
          const url = this.preview(kind, asset);
          // Keep the same loaded image element across tabs and searches.
          // Even a thumbnail finishing on an inactive tab is retained.
          tile.querySelector("img").src = url;
          tile.querySelector("img").hidden = false;
          tile.disabled = false;
          tile.draggable = true;
          tile.dataset.state = "ready";
        } catch (error) {
          // Ignore a result from before Clear/Rescan, including failed IPC.
          if (this.tiles.get(key) !== tile) {
            continue;
          }
          this.skip(kind, name, error);
        }
        // Yield between tiles so dragging and typing remain responsive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.running = false;
    }
  }

  preview(kind, asset) {
    const item = createItem(kind === "fonts" ? "text" : "image", []);
    this.previewResources.materials.clear();
    if (kind === "fonts") {
      const atlas = this.resources.materials.get(asset.material);
      if (!atlas) {
        throw new Error("The stock font atlas could not be loaded.");
      }
      this.previewResources.materials.set(atlas.name, atlas);
      // Rename only this private preview record to select its actual glyphs
      // directly. Export still uses WaW's real font IDs and adaptive rules.
      this.previewResources.fonts = [{ ...asset, name: "normalFont" }];
      item.font = 1;
      item.text = "Aa Bb 0123";
      // One atlas pixel per CSS pixel. Equalising every font's height made
      // distinct stock sizes look alike and magnified the tiny smallFont atlas.
      item.scale = token(asset.height / 48);
      item.align = 9;
      item.rect = ["8", "0", "164", "72", 5, 5];
    } else {
      this.previewResources.materials.set(asset.name, asset);
      const image = asset.levels[0];
      const scale = Math.min(164 / image.width, 60 / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      item.material = asset.name;
      item.rect = [
        token((180 - width) / 2),
        token((72 - height) / 2),
        token(width),
        token(height),
        5,
        5,
      ];
    }
    this.renderer.clearTextures();
    this.renderer.render(
      { viewport: { width: 180, height: 72 }, items: [item] },
      { x: 0, y: 0, scale: 1 },
    );
    const url = this.canvas.toDataURL("image/png");
    this.renderer.clearTextures();
    this.previewResources.materials.clear();
    return url;
  }

  sharedSample(font, reference) {
    const other = this.resources.fonts.find(
      (entry) => entry.name === reference,
    );
    if (!other || other.material !== font.material) {
      return false;
    }
    return [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"].every(
      (character) => {
        const code = character.charCodeAt(0);
        const glyph = font.glyphs.find((entry) => entry.letter === code);
        const comparison = other.glyphs.find((entry) => entry.letter === code);
        return (
          glyph &&
          comparison &&
          JSON.stringify(glyph) === JSON.stringify(comparison)
        );
      },
    );
  }

  enableDrop() {
    const canvas = element("workspace");
    // Turning off Tauri's native file-drop handler enables internal HTML drags.
    // Keep unrelated file/URL drops from navigating away from an unsaved HUD.
    for (const type of ["dragover", "drop"]) {
      document.addEventListener(type, (event) => {
        const types = event.dataTransfer.types;
        if (types.includes("Files") || types.includes("text/uri-list")) {
          event.preventDefault();
        }
      });
    }
    canvas.addEventListener("dragover", (event) => {
      if (event.dataTransfer.types.includes(assetType)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        canvas.classList.add("asset-drop-target");
      }
    });
    canvas.addEventListener("dragleave", (event) => {
      if (!canvas.contains(event.relatedTarget)) {
        canvas.classList.remove("asset-drop-target");
      }
    });
    document.addEventListener("dragend", () =>
      canvas.classList.remove("asset-drop-target"),
    );
    canvas.addEventListener("drop", (event) => {
      canvas.classList.remove("asset-drop-target");
      if (!event.dataTransfer.types.includes(assetType)) {
        return;
      }
      event.preventDefault();
      let asset;
      try {
        asset = JSON.parse(event.dataTransfer.getData(assetType));
      } catch {
        return;
      }
      const known =
        asset?.kind === "local"
          ? this.local.known(asset.name)
          : asset?.kind === "materials"
            ? this.names.includes(asset.name)
            : asset?.kind === "fonts" &&
              this.resources.fonts.some((font) => font.name === asset.name);
      if (known) {
        this.callbacks.choose(asset.kind, asset.name, null, {
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }
    });
  }

  resize() {
    const handle = element("tray-resize");
    const tray = element("asset-tray");
    const setHeight = (height) => {
      const maximum = Math.max(
        150,
        document.querySelector(".canvas-panel").clientHeight - 190,
      );
      const value = Math.max(150, Math.min(maximum, height));
      tray.style.setProperty("--tray-height", `${value}px`);
      handle.setAttribute("aria-valuenow", String(Math.round(value)));
    };
    let drag = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }
      drag = { y: event.clientY, height: tray.clientHeight };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (drag) {
        setHeight(drag.height + drag.y - event.clientY);
      }
    });
    handle.addEventListener("lostpointercapture", () => {
      drag = null;
    });
    handle.addEventListener("pointerup", (event) => {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      drag = null;
    });
    handle.addEventListener("keydown", (event) => {
      if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        setHeight(tray.clientHeight + (event.key === "ArrowUp" ? 20 : -20));
      }
    });
    new ResizeObserver(() => {
      if (!tray.classList.contains("collapsed")) {
        setHeight(tray.clientHeight);
      }
    }).observe(document.querySelector(".canvas-panel"));
  }
}
