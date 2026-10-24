import { invoke } from "@tauri-apps/api/core";

const element = (id) => document.getElementById(id);

/** Independent export actions share a review, never an automatic sequence. */
export class ModExport {
  constructor({ source, project, desktop, message, resolve }) {
    this.source = source;
    this.project = project;
    this.desktop = desktop;
    this.message = message;
    this.resolve = resolve;
    this.sourceError = "";
    this.request = null;
    this.review = null;
    this.kind = null;
    this.running = false;

    for (const id of ["export-mod", "export-profile", "export-name"]) {
      element(id).addEventListener("change", () => this.invalidate());
    }
    element("export-name").addEventListener("input", () => this.invalidate());
    element("export-refresh").addEventListener("click", () =>
      this.work(() => this.refresh()),
    );
    element("export-review").addEventListener("click", () =>
      this.work(() => this.inspect("setup")),
    );
    element("export-images-review").addEventListener("click", () =>
      this.work(() => this.inspect("images")),
    );
    element("export-prepare").addEventListener("click", () =>
      this.work(() => this.prepare()),
    );
    element("export-discard").addEventListener("click", () =>
      this.invalidate(),
    );
    element("export-dialog").addEventListener("cancel", (event) => {
      if (this.running) {
        event.preventDefault();
      }
    });
  }

  materials() {
    return [
      ...new Set(
        this.project()
          .items.filter(
            (item) =>
              item.kind === "image" && !item.localImage && item.material,
          )
          .map((item) => item.material),
      ),
    ];
  }

  async open() {
    // Keep independent export actions accessible even while local design images
    // still need converted materials, or another code dependency is unavailable.
    this.sourceError = "";
    element("export-source").value = "";
    try {
      element("export-source").value = this.source();
    } catch (error) {
      this.sourceError = String(error.message || error);
    }
    const pending = this.project().items.filter((item) => item.localImage);
    element("export-local").hidden = pending.length === 0;
    const links = element("export-local-items");
    links.replaceChildren();
    for (const item of pending) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent =
        item.name + " · " + item.localImage.path.split(/[\\/]/).pop();
      const button = document.createElement("button");
      button.textContent = "Assign material…";
      button.addEventListener("click", () => this.resolve(item.id));
      row.append(label, button);
      links.append(row);
    }
    element("export-code-status").textContent = this.sourceError;
    const materials = this.materials();
    element("export-materials").textContent = materials
      .map((name) => "material," + name)
      .join("\n");
    element("export-material-dependencies").hidden = materials.length === 0;
    element("export-image-count").textContent = materials.length
      ? materials.length +
        " image material(s) used by this HUD. Shared images are copied once."
      : "This HUD has no image materials to copy.";
    const suggested = this.project()
      .name.replace(/[^A-Za-z0-9_]/g, "_")
      .slice(0, 40);
    if (this.suggestedName !== suggested) {
      element("export-name").value = suggested || "my_hud";
      this.suggestedName = suggested;
    }
    this.invalidate();
    element("export-error").textContent = "";
    element("export-completed").hidden = true;
    element("export-dialog").showModal();
    element("export-dialog").scrollTop = 0;
    if (this.desktop) {
      await this.work(() => this.refresh());
    } else {
      element("export-mod-hint").textContent =
        "Open the desktop app to copy images or set up a mod. Code export is available here.";
      this.controls();
    }
  }

  async work(task) {
    if (this.running) {
      return;
    }
    this.running = true;
    element("export-error").textContent = "";
    this.controls();
    try {
      await task();
    } catch (error) {
      element("export-error").textContent = String(error.message || error);
    } finally {
      this.running = false;
      this.controls();
    }
  }

  controls() {
    for (const control of element("export-dialog").querySelectorAll(
      "button, select, input",
    )) {
      control.disabled = this.running;
    }
    const unavailable = this.running || !this.desktop;
    element("export-mod").disabled = unavailable;
    element("export-refresh").disabled = unavailable;
    element("save-export").disabled = unavailable || Boolean(this.sourceError);
    element("copy-source").disabled = this.running || Boolean(this.sourceError);
    const noMod = unavailable || !element("export-mod").value;
    element("export-review").disabled = noMod || Boolean(this.sourceError);
    element("export-images-review").disabled =
      noMod || this.materials().length === 0;
    element("export-prepare").disabled = unavailable || !this.review;
    element("export-progress").textContent = this.running
      ? "Checking or preparing the selected files…"
      : "";
  }

  invalidate() {
    this.request = null;
    this.review = null;
    this.kind = null;
    element("export-review-panel").hidden = true;
    this.controls();
  }

  async refresh() {
    const select = element("export-mod");
    const previous = select.value;
    this.invalidate();
    const mods = await invoke("list_mods");
    select.replaceChildren();
    select.add(
      new Option(mods.length ? "Choose your mod…" : "No mods found", ""),
    );
    for (const mod of mods) {
      select.add(new Option(mod, mod));
    }
    if (mods.includes(previous)) {
      select.value = previous;
    }
    element("export-mod-hint").textContent = mods.length
      ? "Close Launcher before changing its image selections. Reopen it afterwards."
      : "No mods found. You can still copy or save the HUD code.";
  }

  async inspect(kind) {
    this.invalidate();
    element("export-completed").hidden = true;
    const request = {
      modName: element("export-mod").value,
      materials: this.materials(),
    };
    let command = "review_image_export";
    let args = { request };
    if (kind === "setup") {
      request.hudName = element("export-name").value.trim();
      request.profile = element("export-profile").value;
      request.source = this.source();
      command = "review_mod_export";
      args = { request, copyImages: false };
    }
    const review = await invoke(command, args);
    this.kind = kind;
    this.request = request;
    this.review = review;
    element("export-review-title").textContent =
      kind === "images" ? "Review image files" : "Review HUD setup";
    element("export-prepare").textContent =
      kind === "images" ? "Copy images" : "Set up HUD";
    element("export-folder").textContent = review.folder;
    const body = element("export-files");
    body.replaceChildren();
    for (const change of review.changes) {
      const row = document.createElement("tr");
      for (const text of [change.action, change.path, change.purpose]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.append(cell);
      }
      body.append(row);
    }
    element("export-review-panel").hidden = false;
    element("export-review-panel").scrollIntoView({ block: "nearest" });
  }

  async prepare() {
    if (!this.review) {
      return;
    }
    const kind = this.kind;
    const args = {
      request: this.request,
      fingerprint: this.review.fingerprint,
    };
    let command = "prepare_image_export";
    if (kind === "setup") {
      command = "prepare_mod_export";
      args.copyImages = false;
    }
    const result = await invoke(command, args);
    element("export-result").textContent = result.changed
      ? (kind === "images" ? "Images prepared. " : "HUD setup prepared. ") +
        result.changed +
        " file(s) changed in " +
        result.folder
      : "The selected files already match. Nothing needed changing.";
    element("export-build-hint").textContent =
      kind === "images"
        ? "Build the IWD file in Launcher. If integrating the code yourself, add the material entries shown above to mod.csv as needed. No HUD source or mod.csv was changed by this action."
        : "Build mod.ff in Launcher. If your HUD uses images, use the separate Images option and build the IWD too. HUD-only changes do not need a level recompile.";
    element("export-backups").textContent = result.backups.length
      ? "Backups saved beside changed files:\n" + result.backups.join("\n")
      : "No existing files needed backing up.";
    this.invalidate();
    element("export-completed").hidden = false;
    element("export-completed").scrollIntoView({ block: "nearest" });
    this.message(
      kind === "images"
        ? "HUD images prepared. Build the IWD in Launcher."
        : "HUD setup prepared. Build mod.ff in Launcher.",
    );
  }
}
