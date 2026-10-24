import { bounds, placement, setBounds } from "./layout.js";
import { number, token } from "./document.js";
import { Renderer } from "./renderer.js";
import { visualBounds, resizeText } from "./text-controls.js";

export class Workspace {
  constructor(element, callbacks, resources) {
    this.element = element;
    this.callbacks = callbacks;
    this.resources = resources;
    this.canvas = element.querySelector("#scene");
    this.overlay = element.querySelector("#overlay");
    this.renderer = new Renderer(this.canvas, resources);
    this.frame = { x: 30, y: 30, scale: 0.5 };
    this.fitted = true;
    this.grid = true;
    this.snap = true;
    this.snapSize = 8;
    this.space = false;
    this.drag = null;
    this.request = 0;
    new ResizeObserver(() => {
      // Keep the whole HUD visible when a fitted canvas changes size, including
      // opening the asset tray. Deliberate zooming/panning stays under user control.
      if (this.fitted && !this.drag) {
        this.fit();
      } else {
        this.draw();
      }
    }).observe(element);
    element.addEventListener("pointerdown", (event) => this.down(event));
    element.addEventListener("pointermove", (event) => this.move(event));
    element.addEventListener("pointerup", (event) => this.up(event));
    element.addEventListener("pointercancel", () => this.cancel());
    element.addEventListener("lostpointercapture", () => {
      if (this.drag) {
        this.cancel();
      }
    });
    element.addEventListener("wheel", (event) => this.wheel(event), {
      passive: false,
    });
    element.addEventListener("contextmenu", (event) => event.preventDefault());
    window.addEventListener("keydown", (event) => {
      if (event.code === "Space" && !this.editing()) {
        this.space = true;
        event.preventDefault();
      }
      if (event.key === "Escape") {
        this.cancel();
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        this.space = false;
      }
    });
    window.addEventListener("blur", () => {
      this.space = false;
      this.cancel();
    });
  }

  editing() {
    return document.activeElement?.matches("input, textarea, select");
  }

  fit() {
    this.fitted = true;
    const viewport = this.callbacks.project().viewport;
    this.frame.scale = Math.min(
      (this.element.clientWidth - 80) / viewport.width,
      (this.element.clientHeight - 80) / viewport.height,
    );
    this.frame.x =
      (this.element.clientWidth - viewport.width * this.frame.scale) / 2;
    this.frame.y =
      (this.element.clientHeight - viewport.height * this.frame.scale) / 2;
    this.draw();
  }

  point(event) {
    const rect = this.element.getBoundingClientRect();
    return [
      (event.clientX - rect.left - this.frame.x) / this.frame.scale,
      (event.clientY - rect.top - this.frame.y) / this.frame.scale,
    ];
  }

  selected() {
    return this.callbacks
      .project()
      .items.filter((item) => this.callbacks.selection().has(item.id));
  }

  handles(item) {
    const [x, y, w, h] = visualBounds(
      item,
      this.callbacks.project().viewport,
      this.resources.fonts,
    );
    return [
      [x, y],
      [x + w / 2, y],
      [x + w, y],
      [x + w, y + h / 2],
      [x + w, y + h],
      [x + w / 2, y + h],
      [x, y + h],
      [x, y + h / 2],
    ];
  }

  down(event) {
    if (event.target !== this.overlay) {
      return;
    }
    this.element.focus();
    const point = this.point(event);
    if (event.button === 1 || (event.button === 0 && this.space)) {
      this.fitted = false;
      this.drag = {
        type: "pan",
        start: [event.clientX, event.clientY],
        frame: { ...this.frame },
      };
    } else if (event.button === 0) {
      const project = this.callbacks.project();
      const selected = this.selected();
      let handle = -1;
      if (selected.length === 1 && !selected[0].locked) {
        const nearby = this.handles(selected[0])
          .map(([x, y], index) => {
            const dx = Math.abs(x - point[0]) * this.frame.scale;
            const dy = Math.abs(y - point[1]) * this.frame.scale;
            return { index, dx, dy, distance: Math.hypot(dx, dy) };
          })
          .filter((candidate) => candidate.dx <= 7 && candidate.dy <= 7);
        // Small text has closely spaced handles. Choose the nearest handle,
        // rather than whichever happens to appear first in the list.
        nearby.sort((a, b) => a.distance - b.distance);
        handle = nearby[0]?.index ?? -1;
      }
      if (handle >= 0) {
        this.drag = {
          type: "resize",
          handle,
          start: point,
          project: structuredClone(project),
          id: selected[0].id,
        };
      } else {
        const hit = [...project.items].reverse().find((item) => {
          if (item.hidden || !item.visible || item.locked) {
            return false;
          }
          const [x, y, w, h] = visualBounds(
            item,
            project.viewport,
            this.resources.fonts,
          );
          return (
            point[0] >= x &&
            point[0] <= x + w &&
            point[1] >= y &&
            point[1] <= y + h
          );
        });
        if (hit) {
          const ids = new Set(
            event.shiftKey
              ? this.callbacks.selection()
              : this.callbacks.selection().has(hit.id)
                ? this.callbacks.selection()
                : [],
          );
          const members = hit.group
            ? project.items.filter((item) => item.group === hit.group)
            : [hit];
          for (const member of members) {
            if (event.shiftKey && ids.has(member.id)) {
              ids.delete(member.id);
            } else {
              ids.add(member.id);
            }
          }
          this.callbacks.select(ids);
          this.drag = {
            type: "move",
            start: point,
            project: structuredClone(project),
          };
        } else {
          this.drag = {
            type: "marquee",
            start: point,
            end: point,
            previous: event.shiftKey
              ? new Set(this.callbacks.selection())
              : new Set(),
          };
          this.callbacks.select(new Set(this.drag.previous));
        }
      }
    } else {
      return;
    }
    this.element.setPointerCapture(event.pointerId);
    this.draw();
  }

  move(event) {
    const point = this.point(event);
    this.callbacks.position(point);
    if (!this.drag) {
      return;
    }
    const drag = this.drag;
    if (drag.type === "pan") {
      this.frame.x = drag.frame.x + event.clientX - drag.start[0];
      this.frame.y = drag.frame.y + event.clientY - drag.start[1];
    } else if (drag.type === "marquee") {
      drag.end = point;
    } else {
      const project = this.callbacks.project();
      let dx = point[0] - drag.start[0];
      let dy = point[1] - drag.start[1];
      const snap = this.snap && !event.altKey;
      const step = this.snapSize;
      if (drag.type === "move") {
        const originals = drag.project.items.filter(
          (item) => this.callbacks.selection().has(item.id) && !item.locked,
        );
        if (snap && originals.length) {
          const p = placement(originals[0], project.viewport);
          // WaW offsets a bordered item's visible rectangle by its thickness.
          // Snap that visible edge; the grid itself must not inherit the border.
          const border = originals[0].border
            ? number(originals[0].thickness)
            : 0;
          const x = number(originals[0].rect[0]) + border;
          const y = number(originals[0].rect[1]) + border;
          dx = (Math.round((x + dx / p.x.scale) / step) * step - x) * p.x.scale;
          dy = (Math.round((y + dy / p.y.scale) / step) * step - y) * p.y.scale;
        }
        for (const original of originals) {
          const item = project.items.find((entry) => entry.id === original.id);
          const rect = bounds(original, project.viewport);
          setBounds(
            item,
            [rect[0] + dx, rect[1] + dy, rect[2], rect[3]],
            project.viewport,
          );
        }
      } else {
        const original = drag.project.items.find((item) => item.id === drag.id);
        const item = project.items.find((entry) => entry.id === drag.id);
        let [x, y, w, h] = visualBounds(
          original,
          project.viewport,
          this.resources.fonts,
        );
        const right = x + w;
        const bottom = y + h;
        const leftHandle = [0, 6, 7].includes(drag.handle);
        const rightHandle = [2, 3, 4].includes(drag.handle);
        const topHandle = [0, 1, 2].includes(drag.handle);
        const bottomHandle = [4, 5, 6].includes(drag.handle);
        if (snap) {
          const p = placement(item, project.viewport);
          const snapEdge = (value, axis) => {
            const origin = axis.offset;
            return (
              Math.round((value - origin) / axis.scale / step) *
                step *
                axis.scale +
              origin
            );
          };
          dx = leftHandle
            ? snapEdge(x + dx, p.x) - x
            : snapEdge(right + dx, p.x) - right;
          dy = topHandle
            ? snapEdge(y + dy, p.y) - y
            : snapEdge(bottom + dy, p.y) - bottom;
        }
        if (leftHandle) {
          x = Math.min(right, x + dx);
          w = right - x;
        } else if (rightHandle) {
          w = Math.max(0, w + dx);
        }
        if (topHandle) {
          y = Math.min(bottom, y + dy);
          h = bottom - y;
        } else if (bottomHandle) {
          h = Math.max(0, h + dy);
        }
        if (item.kind === "text") {
          resizeText(
            item,
            original,
            [x, y, w, h],
            drag.handle,
            project.viewport,
            this.resources.fonts,
          );
        } else {
          setBounds(item, [x, y, w, h], project.viewport);
        }
      }
      this.callbacks.preview();
    }
    this.draw();
  }

  up(event) {
    if (!this.drag) {
      return;
    }
    const drag = this.drag;
    if (drag.type === "marquee") {
      const ids = drag.previous;
      const minX = Math.min(drag.start[0], drag.end[0]);
      const minY = Math.min(drag.start[1], drag.end[1]);
      const maxX = Math.max(drag.start[0], drag.end[0]);
      const maxY = Math.max(drag.start[1], drag.end[1]);
      for (const item of this.callbacks.project().items) {
        const [x, y, w, h] = visualBounds(
          item,
          this.callbacks.project().viewport,
          this.resources.fonts,
        );
        if (
          !item.hidden &&
          item.visible &&
          !item.locked &&
          x >= minX &&
          y >= minY &&
          x + w <= maxX &&
          y + h <= maxY
        ) {
          ids.add(item.id);
        }
      }
      this.callbacks.select(ids);
    } else if (drag.type === "move" || drag.type === "resize") {
      this.callbacks.commit();
    }
    this.drag = null;
    if (this.element.hasPointerCapture(event.pointerId)) {
      this.element.releasePointerCapture(event.pointerId);
    }
    this.draw();
  }

  cancel() {
    if (this.drag?.project) {
      this.callbacks.restore(this.drag.project);
    }
    this.drag = null;
    this.draw();
  }

  wheel(event) {
    this.fitted = false;
    event.preventDefault();
    const point = this.point(event);
    const factor = Math.exp(-event.deltaY * 0.001);
    const scale = Math.max(0.08, Math.min(8, this.frame.scale * factor));
    const rect = this.element.getBoundingClientRect();
    this.frame.x = event.clientX - rect.left - point[0] * scale;
    this.frame.y = event.clientY - rect.top - point[1] * scale;
    this.frame.scale = scale;
    this.draw();
  }

  draw() {
    if (this.request) {
      return;
    }
    this.request = requestAnimationFrame(() => {
      this.request = 0;
      const project = this.callbacks.project();
      this.renderer.render(project, this.frame);
      this.drawOverlay(project);
      this.callbacks.zoom(this.frame.scale);
    });
  }

  drawStarterHint(ctx, rect) {
    const padding = Math.min(12, rect[2] / 12, rect[3] / 12);
    const width = rect[2] - padding * 2;
    const height = rect[3] - padding * 2;
    const words = "Start with text, a rectangle or a converted material.".split(
      " ",
    );

    // Wrap first to keep the hint readable, then shrink it if needed. At tiny
    // canvas sizes, omit the hint rather than drawing clipped fragments.
    ctx.save();
    ctx.fillStyle = "#9aafc2";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let size = 14; size >= 8; size--) {
      ctx.font = `${size}px "Segoe UI"`;
      const lines = [];
      let line = "";
      for (const word of words) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > width) {
          lines.push(line);
          line = word;
        } else {
          line = next;
        }
      }
      lines.push(line);
      const lineHeight = size * 1.4;
      if (
        lines.length * lineHeight > height ||
        lines.some((text) => ctx.measureText(text).width > width)
      ) {
        continue;
      }

      ctx.beginPath();
      ctx.rect(rect[0] + padding, rect[1] + padding, width, height);
      ctx.clip();
      const top = rect[1] + rect[3] / 2 - ((lines.length - 1) * lineHeight) / 2;
      for (const [index, text] of lines.entries()) {
        ctx.fillText(text, rect[0] + rect[2] / 2, top + index * lineHeight);
      }
      break;
    }
    ctx.restore();
  }

  drawOverlay(project) {
    const dpr = window.devicePixelRatio || 1;
    const width = this.element.clientWidth;
    const height = this.element.clientHeight;
    this.overlay.width = Math.round(width * dpr);
    this.overlay.height = Math.round(height * dpr);
    const ctx = this.overlay.getContext("2d");
    ctx.scale(dpr, dpr);
    const screen = ([x, y]) => [
      this.frame.x + x * this.frame.scale,
      this.frame.y + y * this.frame.scale,
    ];
    const rect = [
      this.frame.x,
      this.frame.y,
      project.viewport.width * this.frame.scale,
      project.viewport.height * this.frame.scale,
    ];
    ctx.strokeStyle = "#536475";
    ctx.strokeRect(...rect);
    if (this.grid) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(...rect);
      ctx.clip();
      ctx.fillStyle = "#b2cce1bb";
      const selected = this.selected()[0];
      const nominal = Math.min(
        project.viewport.width / 640,
        project.viewport.height / 480,
      );
      const axes = selected
        ? placement(selected, project.viewport)
        : {
            x: { scale: nominal, offset: 0 },
            y: { scale: nominal, offset: 0 },
          };
      const stepX = this.snapSize * axes.x.scale;
      const stepY = this.snapSize * axes.y.scale;
      // Anchors determine the coordinate system, but borders are item styling:
      // selecting a bordered item must not translate the grid's origin.
      const startX = ((axes.x.offset % stepX) + stepX) % stepX;
      const startY = ((axes.y.offset % stepY) + stepY) % stepY;
      if (Math.min(stepX, stepY) * this.frame.scale >= 5) {
        for (let x = startX; x < project.viewport.width; x += stepX) {
          for (let y = startY; y < project.viewport.height; y += stepY) {
            const point = screen([x, y]);
            // A dark rim keeps points legible over light screenshot references too.
            ctx.fillStyle = "#0c1724aa";
            ctx.fillRect(point[0] - 0.75, point[1] - 0.75, 3, 3);
            ctx.fillStyle = "#b2cce1dd";
            ctx.fillRect(point[0], point[1], 1.5, 1.5);
          }
        }
      }
      ctx.restore();
    }
    if (
      project.items.length === 0 &&
      !(
        project.background?.visible &&
        this.resources.localImages?.has(project.background.path)
      )
    ) {
      this.drawStarterHint(ctx, rect);
    }
    for (const item of project.items) {
      if (
        item.kind === "image" &&
        !(item.localImage
          ? this.resources.localImages?.has(item.localImage.path)
          : this.resources.materials.has(item.material)) &&
        !item.hidden
      ) {
        const box = bounds(item, project.viewport);
        const [x, y] = screen(box);
        ctx.strokeStyle = "#dcae71";
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(
          x,
          y,
          box[2] * this.frame.scale,
          box[3] * this.frame.scale,
        );
        ctx.setLineDash([]);
        ctx.fillStyle = "#dcae71";
        ctx.font = '11px "Segoe UI"';
        ctx.textAlign = "left";
        ctx.fillText(
          item.localImage ? "Local image unavailable" : "Choose material…",
          x + 8,
          y + 18,
        );
      }
    }
    for (const item of this.selected()) {
      const box = visualBounds(item, project.viewport, this.resources.fonts);
      const [x, y] = screen(box);
      ctx.strokeStyle = "#54aaf0";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        x,
        y,
        box[2] * this.frame.scale,
        box[3] * this.frame.scale,
      );
      ctx.fillStyle = "#cfe8ff";
      ctx.font = '11px "Segoe UI"';
      ctx.textAlign = "left";
      ctx.fillText(item.name, x, y - 7);
      if (this.selected().length === 1 && !item.locked) {
        for (const handle of this.handles(item)) {
          const [hx, hy] = screen(handle);
          ctx.fillStyle = "#19222a";
          ctx.fillRect(hx - 3, hy - 3, 6, 6);
          ctx.strokeRect(hx - 3, hy - 3, 6, 6);
        }
        const p = placement(item, project.viewport);
        const [ax, ay] = screen([p.x.offset, p.y.offset]);
        ctx.strokeStyle = "#728da7";
        ctx.beginPath();
        ctx.moveTo(ax - 5, ay);
        ctx.lineTo(ax + 5, ay);
        ctx.moveTo(ax, ay - 5);
        ctx.lineTo(ax, ay + 5);
        ctx.stroke();
      }
    }
    if (this.drag?.type === "marquee") {
      const start = screen(this.drag.start);
      const end = screen(this.drag.end);
      ctx.strokeStyle = "#54aaf0";
      ctx.fillStyle = "#328ad31f";
      ctx.fillRect(start[0], start[1], end[0] - start[0], end[1] - start[1]);
      ctx.strokeRect(start[0], start[1], end[0] - start[0], end[1] - start[1]);
    }
  }
}
