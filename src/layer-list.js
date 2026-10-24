// Keep row nodes stable so selection changes do not interrupt double-clicks,
// inline editing or pointer gestures.
export class LayerList {
  constructor(element, callbacks) {
    this.element = element;
    this.callbacks = callbacks;
    this.rows = new Map();
    this.pointer = null;
    this.editing = null;
    this.scrollFrame = 0;
    this.suppressClick = false;
    this.indicator = document.createElement("div");
    this.indicator.className = "layer-drop-indicator";
    this.indicator.hidden = true;
    document.body.append(this.indicator);
    element.addEventListener("click", (event) => this.click(event));
    element.addEventListener("dblclick", (event) => this.rename(event));
    element.addEventListener("pointerdown", (event) => this.down(event));
    window.addEventListener("pointermove", (event) => this.move(event));
    window.addEventListener("pointerup", (event) => this.up(event));
    element.addEventListener("pointercancel", () => this.cancel());
    element.addEventListener("lostpointercapture", () => this.cancel());
    window.addEventListener("blur", () => this.cancel());
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.pointer) {
        event.preventDefault();
        this.cancel();
      }
    });
  }

  get interacting() {
    return Boolean(this.pointer);
  }

  render() {
    const items = [...this.callbacks.items()].reverse();
    const ids = new Set(items.map((item) => item.id));
    if (this.editing && !ids.has(this.editing.id)) {
      this.editing = null;
    }
    for (const [id, row] of this.rows) {
      if (!ids.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    }
    this.element.querySelector(".empty-layers")?.remove();
    let cursor = this.element.firstElementChild;
    for (const item of items) {
      let row = this.rows.get(item.id);
      if (!row) {
        row = document.createElement("div");
        row.className = "layer";
        row.dataset.id = item.id;
        row.setAttribute("role", "option");
        for (const name of ["layer-kind", "layer-name"]) {
          const span = document.createElement("span");
          span.className = name;
          row.append(span);
        }
        for (const name of ["hide", "lock"]) {
          const button = document.createElement("button");
          button.dataset[name] = "";
          row.append(button);
        }
        this.rows.set(item.id, row);
      }
      const selected = this.callbacks.selection().has(item.id);
      row.classList.toggle("selected", selected);
      row.classList.toggle(
        "dragging",
        Boolean(this.pointer?.dragging && this.pointer.ids.has(item.id)),
      );
      row.setAttribute("aria-selected", String(selected));
      row.querySelector(".layer-kind").textContent = {
        text: "T",
        image: "▧",
        rectangle: "□",
      }[item.kind];
      const label = row.querySelector(".layer-name");
      if (this.editing?.id !== item.id) {
        label.textContent = item.name + (item.group ? " ·" : "");
        label.title = item.name + " — double-click to rename; drag to reorder";
      }
      const hide = row.querySelector("[data-hide]");
      hide.textContent = item.hidden ? "○" : "◉";
      hide.classList.toggle("active", item.hidden);
      hide.title = "Hide in editor only";
      hide.setAttribute(
        "aria-label",
        (item.hidden ? "Show " : "Hide ") + item.name + " in editor",
      );
      const lock = row.querySelector("[data-lock]");
      lock.textContent = item.locked ? "L" : "·";
      lock.classList.toggle("active", item.locked);
      lock.title = "Lock in editor only";
      lock.setAttribute(
        "aria-label",
        (item.locked ? "Unlock " : "Lock ") + item.name,
      );
      if (row !== cursor) {
        this.element.insertBefore(row, cursor);
      }
      cursor = row.nextElementSibling;
    }
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "hint empty-layers";
      empty.append(
        "Your layers will appear here.",
        document.createElement("br"),
        "Topmost layers draw in front.",
      );
      this.element.append(empty);
    }
  }

  click(event) {
    if (this.suppressClick || event.target.closest("input")) {
      return;
    }
    const row = event.target.closest(".layer");
    if (!row) {
      return;
    }
    const id = row.dataset.id;
    if (event.target.closest("[data-hide]")) {
      this.callbacks.toggle(id, "hidden");
    } else if (event.target.closest("[data-lock]")) {
      this.callbacks.toggle(id, "locked");
    } else {
      const ids = event.shiftKey
        ? new Set(this.callbacks.selection())
        : new Set();
      if (ids.has(id)) {
        ids.delete(id);
      } else {
        ids.add(id);
      }
      this.callbacks.select(ids);
    }
  }

  rename(event) {
    if (event.target.closest("button, input")) {
      return;
    }
    const row = event.target.closest(".layer");
    const item = this.callbacks
      .items()
      .find((item) => item.id === row?.dataset.id);
    if (!item) {
      return;
    }
    event.preventDefault();
    this.callbacks.select(new Set([item.id]));
    const input = document.createElement("input");
    input.className = "layer-rename";
    input.setAttribute("aria-label", "Rename layer");
    input.maxLength = 64;
    input.value = item.name;
    this.editing = { id: item.id, input };
    row.querySelector(".layer-name").replaceChildren(input);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.finishRename(event.key === "Enter");
      }
    });
    input.addEventListener("blur", () => this.finishRename(true, true));
    input.focus();
    input.select();
  }

  finishRename(commit, leaving = false) {
    const edit = this.editing;
    if (!edit) {
      return;
    }
    this.editing = null;
    try {
      if (commit) {
        this.callbacks.rename(edit.id, edit.input.value.trim());
      }
      this.render();
    } catch (error) {
      this.callbacks.error(error.message);
      if (leaving) {
        this.render();
      } else {
        this.editing = edit;
        edit.input.setAttribute("aria-invalid", "true");
        edit.input.title = error.message;
        edit.input.focus();
        edit.input.select();
      }
    }
  }

  down(event) {
    if (!this.pointer) {
      this.suppressClick = false;
    }
    if (
      event.button !== 0 ||
      this.pointer ||
      event.target.closest("button, input")
    ) {
      return;
    }
    const row = event.target.closest(".layer");
    if (!row) {
      return;
    }
    this.pointer = {
      pointerId: event.pointerId,
      id: row.dataset.id,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
      previous: new Set(this.callbacks.selection()),
      ids: new Set(),
      before: null,
      inside: false,
    };
  }

  move(event) {
    const drag = this.pointer;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.dragging) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 5) {
        return;
      }
      drag.dragging = true;
      drag.ids = drag.previous.has(drag.id)
        ? new Set(drag.previous)
        : new Set([drag.id]);
      this.element.setPointerCapture(drag.pointerId);
      document.body.classList.add("reordering-layers");
      this.callbacks.select(drag.ids);
    }
    event.preventDefault();
    this.dropTarget();
    if (!this.scrollFrame) {
      this.scrollFrame = requestAnimationFrame(() => this.scroll());
    }
  }

  dropTarget() {
    const drag = this.pointer;
    const bounds = this.element.getBoundingClientRect();
    drag.inside =
      drag.x >= bounds.left &&
      drag.x <= bounds.right &&
      drag.y >= bounds.top &&
      drag.y <= bounds.bottom;
    this.indicator.hidden = !drag.inside;
    if (!drag.inside) {
      return;
    }
    const remaining = [...this.element.querySelectorAll(".layer")].filter(
      (row) => !drag.ids.has(row.dataset.id),
    );
    const target = remaining.find((row) => {
      const box = row.getBoundingClientRect();
      return drag.y < box.top + box.height / 2;
    });
    drag.before = target?.dataset.id || null;
    const y = target
      ? target.getBoundingClientRect().top
      : (remaining.at(-1)?.getBoundingClientRect().bottom ?? bounds.top);
    Object.assign(this.indicator.style, {
      left: bounds.left + 8 + "px",
      width: bounds.width - 16 + "px",
      top: Math.max(bounds.top, Math.min(bounds.bottom - 2, y)) + "px",
    });
  }

  scroll() {
    this.scrollFrame = 0;
    const drag = this.pointer;
    if (!drag?.dragging || !drag.inside) {
      return;
    }
    const bounds = this.element.getBoundingClientRect();
    const step =
      drag.y < bounds.top + 25 ? -8 : drag.y > bounds.bottom - 25 ? 8 : 0;
    const previous = this.element.scrollTop;
    this.element.scrollTop += step;
    if (this.element.scrollTop !== previous) {
      this.dropTarget();
      this.scrollFrame = requestAnimationFrame(() => this.scroll());
    }
  }

  up(event) {
    const drag = this.pointer;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag.dragging) {
      this.clear();
      return;
    }
    this.dropTarget();
    const order = [...this.callbacks.items()].reverse().map((item) => item.id);
    const moving = order.filter((id) => drag.ids.has(id));
    const remaining = order.filter((id) => !drag.ids.has(id));
    if (drag.inside) {
      const at = drag.before
        ? remaining.indexOf(drag.before)
        : remaining.length;
      remaining.splice(at, 0, ...moving);
    }
    this.clear();
    this.suppressClick = true;
    setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    if (drag.inside) {
      this.callbacks.reorder(remaining);
    } else {
      this.callbacks.select(drag.previous);
    }
    this.render();
  }

  clear() {
    const drag = this.pointer;
    this.pointer = null;
    cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = 0;
    this.indicator.hidden = true;
    document.body.classList.remove("reordering-layers");
    if (drag && this.element.hasPointerCapture(drag.pointerId)) {
      this.element.releasePointerCapture(drag.pointerId);
    }
  }

  cancel() {
    const drag = this.pointer;
    this.clear();
    if (drag?.dragging) {
      this.suppressClick = true;
      this.callbacks.select(drag.previous);
    }
  }
}
