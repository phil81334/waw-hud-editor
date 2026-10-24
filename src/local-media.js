import { invoke } from "@tauri-apps/api/core";

export const imageFilters = [
  { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "tga"] },
];
export const filename = (path) => path.split(/[\\/]/).pop();

/** Editor references are separate from converted game resources and disk caches. */
export class LocalMedia {
  constructor(resources, renderer, updated) {
    this.resources = resources;
    this.renderer = renderer;
    this.updated = updated;
    this.pending = new Map();
    this.needed = new Set();
    this.restoring = false;
    this.generation = 0;
    this.resources.localImages = new Map();
    this.resources.localErrors = new Map();
  }

  async load(path) {
    if (this.resources.localImages.has(path)) {
      return this.resources.localImages.get(path);
    }
    if (this.pending.has(path)) {
      return this.pending.get(path);
    }
    const request = this.read(path);
    this.pending.set(path, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(path) === request) {
        this.pending.delete(path);
      }
    }
  }

  async read(path) {
    const generation = this.generation;
    try {
      const value = await invoke("read_local_image", {
        path,
        thumbnail: false,
      });
      const image = new Image();
      image.src = value.dataUrl;
      await image.decode();
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const maximum = this.renderer.gl.getParameter(
        this.renderer.gl.MAX_TEXTURE_SIZE,
      );
      if (width > maximum || height > maximum) {
        throw new Error(
          "This image exceeds your graphics device’s texture size limit.",
        );
      }
      let pixels = width * height;
      for (const existing of this.resources.localImages.values()) {
        pixels += existing.levels[0].width * existing.levels[0].height;
      }
      if (pixels * 4 > 128 * 1024 * 1024) {
        throw new Error(
          "Local references exceed 128 MB of decoded pixels. Use smaller images or remove unused references.",
        );
      }
      if (generation !== this.generation) {
        throw new Error("Image reload superseded this request.");
      }
      const picture = {
        name: "local:" + path,
        element: image,
        levels: [{ width, height }],
        blend: "blend",
        sampler: 98,
        alphaTest: 0,
      };
      this.resources.localImages.set(path, picture);
      this.resources.localErrors.delete(path);
      return picture;
    } catch (error) {
      if (generation === this.generation) {
        this.resources.localErrors.set(path, String(error.message || error));
      }
      throw error;
    }
  }

  sync(project) {
    this.needed = new Set(
      project.items
        .filter((item) => item.localImage)
        .map((item) => item.localImage.path),
    );
    if (project.background) {
      this.needed.add(project.background.path);
    }
    this.prune();
    void this.restore();
  }

  async restore() {
    if (this.restoring) {
      return;
    }
    this.restoring = true;
    try {
      // Restore one reference at a time rather than decoding an entire saved
      // HUD's images concurrently. Edits update 'needed' while this loop waits.
      while (true) {
        const path = [...this.needed].find(
          (entry) =>
            !this.resources.localImages.has(entry) &&
            !this.resources.localErrors.has(entry) &&
            !this.pending.has(entry),
        );
        if (!path) {
          break;
        }
        try {
          await this.load(path);
        } catch {
          // read() retains the reason; a missing link must not prevent editing.
        }
        this.prune();
        this.updated();
      }
    } finally {
      this.restoring = false;
    }
  }

  prune() {
    for (const [path, picture] of this.resources.localImages) {
      if (!this.needed.has(path)) {
        this.renderer.releaseTexture(picture.name);
        this.resources.localImages.delete(path);
      }
    }
  }

  retry(project) {
    this.generation += 1;
    this.pending.clear();
    for (const [path, picture] of this.resources.localImages) {
      this.renderer.releaseTexture(picture.name);
      this.resources.localImages.delete(path);
    }
    this.resources.localErrors.clear();
    this.sync(project);
  }
}
