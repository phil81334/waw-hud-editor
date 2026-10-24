import { number, token } from "./document.js";
import { bounds, setBounds, textQuads } from "./layout.js";

// The INC rectangle is a text-layout area, not the extent of the drawn letters.
// Keep that native layout intact while selecting what the user actually sees.
export function visualBounds(item, viewport, fonts) {
  if (item.kind !== "text") {
    return bounds(item, viewport);
  }
  const rectangles = textQuads(item, viewport, fonts)
    .map((glyph) => glyph.rect)
    .filter((rect) => rect[2] > 0 && rect[3] > 0);
  if (item.border || !rectangles.length) {
    rectangles.push(bounds(item, viewport));
  }
  const left = Math.min(...rectangles.map((rect) => rect[0]));
  const top = Math.min(...rectangles.map((rect) => rect[1]));
  const right = Math.max(...rectangles.map((rect) => rect[0] + rect[2]));
  const bottom = Math.max(...rectangles.map((rect) => rect[1] + rect[3]));
  return [left, top, right - left, bottom - top];
}

export function moveVisualTo(item, point, viewport, fonts) {
  const visual = visualBounds(item, viewport, fonts);
  const native = bounds(item, viewport);
  native[0] += point[0] - visual[0];
  native[1] += point[1] - visual[1];
  const size = item.rect.slice(2, 4);
  setBounds(item, native, viewport);
  [item.rect[2], item.rect[3]] = size;
}

export function resizeText(item, original, target, handle, viewport, fonts) {
  const before = visualBounds(original, viewport, fonts);
  const horizontal = [0, 2, 3, 4, 6, 7].includes(handle);
  const vertical = [0, 1, 2, 4, 5, 6].includes(handle);
  const widthRatio = target[2] / Math.max(0.001, before[2]);
  const heightRatio = target[3] / Math.max(0.001, before[3]);
  let ratio = horizontal ? widthRatio : heightRatio;
  if (
    horizontal &&
    vertical &&
    Math.abs(heightRatio - 1) > Math.abs(widthRatio - 1)
  ) {
    ratio = heightRatio;
  }
  const scale = Math.max(0.01, number(original.scale));
  const largest = Math.max(
    scale,
    1,
    ...original.rect.slice(2, 4).map((value) => Math.abs(number(value))),
    ...original.offset.map((value) => Math.abs(number(value))),
    number(original.thickness),
  );
  ratio = Math.max(0.01 / scale, Math.min(1000000 / largest, ratio));

  // A native textscale is uniform. Scale the existing layout area and offsets
  // with it, preserving wrapping/alignment rather than stretching bitmap glyphs.
  item.rect = original.rect.slice();
  item.rect[2] = token(number(original.rect[2]) * ratio);
  item.rect[3] = token(number(original.rect[3]) * ratio);
  item.offset = original.offset.map((value) => token(number(value) * ratio));
  item.scale = token(scale * ratio);
  item.thickness = token(number(original.thickness) * ratio);

  const after = visualBounds(item, viewport, fonts);
  const pivotX = [0, 6, 7].includes(handle)
    ? 1
    : [2, 3, 4].includes(handle)
      ? 0
      : 0.5;
  const pivotY = [0, 1, 2].includes(handle)
    ? 1
    : [4, 5, 6].includes(handle)
      ? 0
      : 0.5;
  moveVisualTo(
    item,
    [
      before[0] + (before[2] - after[2]) * pivotX,
      before[1] + (before[3] - after[3]) * pivotY,
    ],
    viewport,
    fonts,
  );
}
