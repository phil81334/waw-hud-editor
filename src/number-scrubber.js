// Numeric labels are drag handles; the inputs keep their normal typing and
// spinner behaviour. Preview writes are committed as one undoable edit.
export class NumberScrubber {
  constructor(element, callbacks) {
    this.element = element;
    this.callbacks = callbacks;
    this.drag = null;
    element.addEventListener("pointerdown", (event) => this.down(event));
    element.addEventListener("pointermove", (event) => this.move(event));
    element.addEventListener("pointerup", (event) => this.up(event));
    element.addEventListener("pointercancel", () => this.finish(false));
    element.addEventListener("lostpointercapture", () => this.finish(false));
    window.addEventListener("blur", () => this.finish(false));
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.drag) {
        event.preventDefault();
        this.finish(false);
      }
    });
  }

  get active() {
    return Boolean(this.drag);
  }

  down(event) {
    const label = event.target.closest("[data-scrub]");
    if (!label || event.button !== 0 || this.drag) {
      return;
    }
    let input = label.closest("label").querySelector('input[type="number"]');
    const attribute = input.hasAttribute("data-field")
      ? "data-field"
      : "data-alpha";
    const key = input.getAttribute(attribute);
    event.preventDefault();
    // Committing another focused input may rebuild Properties. Find this field
    // again afterwards rather than capturing a detached label.
    document.activeElement?.blur();
    input = this.element.querySelector(
      "[" + attribute + '="' + CSS.escape(key) + '"]',
    );
    if (!input || !Number.isFinite(Number(input.value))) {
      return;
    }
    const handle = input.closest("label").querySelector("[data-scrub]");
    const minimum = input.min === "" ? -1000000 : Number(input.min);
    const maximum = input.max === "" ? 1000000 : Number(input.max);
    this.drag = {
      pointerId: event.pointerId,
      input,
      step: Number(handle.dataset.scrubStep),
      x: event.clientX,
      startX: event.clientX,
      value: Number(input.value),
      original: input.value,
      minimum,
      maximum,
      moved: false,
      snapshot: this.callbacks.begin(),
    };
    this.element.setPointerCapture(event.pointerId);
  }

  move(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < 3) {
      return;
    }
    drag.moved = true;
    document.body.classList.add("scrubbing-number");
    const multiplier = event.shiftKey ? 0.1 : event.ctrlKey ? 10 : 1;
    drag.value = Math.max(
      drag.minimum,
      Math.min(
        drag.maximum,
        drag.value + ((event.clientX - drag.x) * drag.step * multiplier) / 4,
      ),
    );
    drag.x = event.clientX;
    drag.input.value = String(Number(drag.value.toFixed(9)));
    event.preventDefault();
    if (!this.callbacks.preview(drag.input)) {
      this.finish(false);
    }
  }

  up(event) {
    if (this.drag && event.pointerId === this.drag.pointerId) {
      this.finish(true);
    }
  }

  finish(commit) {
    const drag = this.drag;
    if (!drag) {
      return;
    }
    this.drag = null;
    document.body.classList.remove("scrubbing-number");
    if (this.element.hasPointerCapture(drag.pointerId)) {
      this.element.releasePointerCapture(drag.pointerId);
    }
    if (drag.moved) {
      if (commit) {
        this.callbacks.commit();
      } else {
        this.callbacks.cancel(drag.snapshot);
      }
    } else if (commit) {
      drag.input.focus();
      drag.input.select();
    }
  }
}
