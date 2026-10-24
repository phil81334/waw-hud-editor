import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const element = (id) => document.getElementById(id);
const assetType = "application/x-waw-hud-asset";

/** Browses only an explicitly selected folder. No recursive startup disk scan. */
export class LocalBrowser {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.folder = null;
    this.query = "";
    this.scroll = 0;
    this.tiles = new Map();
    this.revision = 0;
    this.loading = false;
    this.error = "";
    this.queue = [];
    this.running = false;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target.dataset.state === "new") {
            this.observer.unobserve(entry.target);
            entry.target.dataset.state = "queued";
            this.queue.push(entry.target);
          }
        }
        void this.drain();
      },
      { root: element("local-list"), rootMargin: "100px" },
    );
    element("local-list").addEventListener("scroll", () => {
      this.scroll = element("local-list").scrollTop;
    });
    element("local-browse").addEventListener("click", () => {
      void this.browse().catch((error) => this.fail(error));
    });
    element("local-up").addEventListener("click", () => {
      if (this.folder?.parent) {
        void this.navigate(this.folder.parent);
      }
    });
  }

  fail(error) {
    this.error = String(error.message || error);
    this.render();
  }

  async browse() {
    const path = await open({
      title: "Choose a local image folder",
      directory: true,
      multiple: false,
      defaultPath: this.folder?.path,
    });
    if (path) {
      await this.navigate(path);
    }
  }

  async navigate(path, refresh = false) {
    const revision = ++this.revision;
    this.loading = true;
    this.error = "";
    this.render();
    try {
      const folder = await invoke("list_image_folder", { path });
      if (revision !== this.revision) {
        return;
      }
      if (refresh || folder.path !== this.folder?.path) {
        this.scroll = 0;
      }
      this.folder = folder;
      // Reuse unchanged thumbnails, including when returning to a parent folder.
      const current = new Map(folder.images.map((file) => [file.path, file]));
      for (const [key, tile] of this.tiles) {
        const file = current.get(key);
        if (
          file &&
          (refresh || tile.dataset.stamp !== `${file.bytes}:${file.modified}`)
        ) {
          this.tiles.delete(key);
        }
      }
      // Bound browsing memory; active folder tiles are always retained.
      for (const key of this.tiles.keys()) {
        if (this.tiles.size <= 1500) {
          break;
        }
        if (!current.has(key)) {
          this.tiles.delete(key);
        }
      }
    } catch (error) {
      if (revision === this.revision) {
        this.error = String(error.message || error);
      }
    } finally {
      if (revision === this.revision) {
        this.loading = false;
        this.render();
      }
    }
  }

  known(path) {
    return this.folder?.images.some((file) => file.path === path);
  }

  refresh() {
    if (this.folder) {
      return this.navigate(this.folder.path, true);
    }
    return this.browse();
  }

  render() {
    if (!this.callbacks.active()) {
      return;
    }
    this.observer.disconnect();
    for (const tile of this.queue) {
      tile.dataset.state = "new";
    }
    this.queue = [];
    const list = element("local-list");
    list.replaceChildren();
    element("local-browse").disabled = this.loading;
    element("local-up").disabled = this.loading || !this.folder?.parent;
    element("reload-assets").disabled = this.loading;
    element("local-path").textContent =
      this.folder?.path || "Choose an image folder.";
    element("local-path").title = this.folder?.path || "";
    const folders = element("local-folders");
    folders.replaceChildren();
    for (const folder of this.folder?.directories || []) {
      const button = document.createElement("button");
      button.textContent = folder.name;
      button.title = folder.path;
      button.disabled = this.loading;
      button.addEventListener("click", () => void this.navigate(folder.path));
      folders.append(button);
    }
    const files = (this.folder?.images || []).filter((file) =>
      file.name.toLowerCase().includes(this.query.trim().toLowerCase()),
    );
    element("asset-summary").textContent = this.loading
      ? "Reading image folder…"
      : this.error ||
        `${files.length} local image(s) · Click to add, or drag onto the HUD. Assign converted materials before game export.`;
    element("asset-cache-status").textContent = this.folder?.truncated
      ? "Folder listing limited to 20,000 entries."
      : this.folder?.skipped
        ? `${this.folder.skipped} unreadable entry/entries skipped.`
        : "PNG, JPG, WebP, BMP and TGA · Original files stay in place; projects save links only.";
    if (this.loading) {
      return;
    }
    for (const file of files) {
      let tile = this.tiles.get(file.path);
      if (!tile) {
        tile = document.createElement("button");
        tile.className = "asset-tile";
        tile.dataset.path = file.path;
        tile.dataset.stamp = `${file.bytes}:${file.modified}`;
        tile.dataset.state = "new";
        tile.disabled = true;
        tile.title = file.path;
        const image = document.createElement("img");
        image.alt = "";
        image.hidden = true;
        image.draggable = false;
        const note = document.createElement("small");
        note.textContent = "Loading preview…";
        const caption = document.createElement("span");
        caption.textContent = file.name;
        tile.append(image, note, caption);
        tile.addEventListener("click", () => this.callbacks.choose(file.path));
        tile.addEventListener("dragstart", (event) => {
          if (tile.disabled) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(
            assetType,
            JSON.stringify({ kind: "local", name: file.path }),
          );
          event.dataTransfer.setDragImage(image, 0, 0);
        });
        this.tiles.set(file.path, tile);
      }
      list.append(tile);
      if (tile.dataset.state === "new") {
        this.observer.observe(tile);
      }
    }
    if (!files.length) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = this.folder
        ? "No matching images in this folder."
        : "Choose Browse… to open a folder of your images.";
      list.append(hint);
    }
    list.scrollTop = this.scroll;
  }

  async drain() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      while (this.queue.length) {
        const tile = this.queue.shift();
        if (!tile.isConnected || !this.callbacks.active()) {
          tile.dataset.state = "new";
          continue;
        }
        tile.dataset.state = "loading";
        try {
          const value = await invoke("read_local_image", {
            path: tile.dataset.path,
            thumbnail: true,
          });
          if (this.tiles.get(tile.dataset.path) !== tile) {
            continue;
          }
          const image = tile.querySelector("img");
          image.src = value.dataUrl;
          image.hidden = false;
          tile.querySelector("small").hidden = true;
          tile.disabled = false;
          tile.draggable = true;
          tile.dataset.state = "ready";
        } catch (error) {
          tile.dataset.state = "failed";
          tile.querySelector("small").textContent = "Preview unavailable";
          tile.title = `${tile.dataset.path}\n${error.message || error}`;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      this.running = false;
    }
  }
}
