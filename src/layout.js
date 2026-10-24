import { number, token, rgba } from "./document.js";

// Each native axis is an affine transform. Its inverse is used by ALL canvas
// operations, rather than converting CSS pixels with a second set of rules.
export function axis(viewport, mode, horizontal) {
  const nominalWidth = Math.min(viewport.width, (viewport.height * 4) / 3);
  const nominalHeight = (nominalWidth * 3) / 4;
  const full = horizontal ? viewport.width : viewport.height;
  const reference = horizontal ? 640 : 480;
  const scale = (horizontal ? nominalWidth : nominalHeight) / reference;
  if (mode === 4) {
    return { scale: full / reference, offset: 0 };
  }
  if (mode === 5) {
    return { scale: 1, offset: 0 };
  }
  if (mode === 6) {
    return { scale: reference / full, offset: 0 };
  }
  let offset = 0;
  if (mode === 2 || mode === 7) {
    offset = full / 2;
  } else if (mode === 3) {
    offset = full;
  } else if (mode === 0) {
    offset = (full - (horizontal ? nominalWidth : nominalHeight)) / 2;
  }
  return { scale, offset };
}

export function placement(item, viewport) {
  return {
    x: axis(viewport, item.rect[4], true),
    y: axis(viewport, item.rect[5], false),
  };
}

export function clientRect(item) {
  const rect = item.rect.slice(0, 4).map(number);
  if (item.border) {
    rect[0] = Math.fround(rect[0] + number(item.thickness));
    rect[1] = Math.fround(rect[1] + number(item.thickness));
  }
  return rect;
}

export function transformRect(rect, item, viewport) {
  const p = placement(item, viewport);
  return [
    rect[0] * p.x.scale + p.x.offset,
    rect[1] * p.y.scale + p.y.offset,
    rect[2] * p.x.scale,
    rect[3] * p.y.scale,
  ];
}

export function bounds(item, viewport) {
  const rect = clientRect(item);
  rect[2] = Math.abs(rect[2]);
  rect[3] = Math.abs(rect[3]);
  return transformRect(rect, item, viewport);
}

export function setBounds(item, screen, viewport) {
  const p = placement(item, viewport);
  const border = item.border ? number(item.thickness) : 0;
  item.rect[0] = token((screen[0] - p.x.offset) / p.x.scale - border);
  item.rect[1] = token((screen[1] - p.y.offset) / p.y.scale - border);
  item.rect[2] = token(
    (Math.max(0, screen[2]) / p.x.scale) * (number(item.rect[2]) < 0 ? -1 : 1),
  );
  item.rect[3] = token(
    (Math.max(0, screen[3]) / p.y.scale) * (number(item.rect[3]) < 0 ? -1 : 1),
  );
}

export function fontFor(item, viewport, fonts) {
  const scale = Math.fround(
    number(item.scale) * axis(viewport, item.rect[5], false).scale,
  );
  const fixed = {
    1: "normalFont",
    2: "bigFont",
    3: "smallFont",
    5: "consoleFont",
    6: "objectiveFont",
  };
  let name = fixed[item.font];
  if (!name) {
    name = "normalFont";
    if (scale <= 0.25) {
      name = "smallFont";
    } else if (item.font === 4 && scale >= Math.fround(0.4)) {
      name = "boldFont";
    } else if (item.font === 0 && scale >= Math.fround(0.55)) {
      name = "extraBigFont";
    } else if (item.font === 0 && scale >= Math.fround(0.4)) {
      name = "bigFont";
    }
  }
  return fonts.find((font) => font.name === name);
}

const palette = [
  [0, 0, 0],
  [1, 0.2, 0.2],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [0, 1, 1],
  [238 / 255, 192 / 255, 98 / 255],
];

export function textWidth(text, font, scale) {
  let width = 0;
  let maximum = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "^" && /[0-9]/.test(text[index + 1] || "!")) {
      index += 1;
    } else if (character === "\r" || character === "\n") {
      width = 0;
    } else {
      width +=
        font.glyphs.find((glyph) => glyph.letter === character.charCodeAt(0))
          ?.advance || 0;
      maximum = Math.max(width, maximum);
    }
  }
  return maximum * scale;
}

function lineEnd(text, start, font, scale, width) {
  let advance = 0;
  let boundary = null;
  let index = start;
  while (index < text.length) {
    const character = text[index];
    let next = index + 1;
    if (character === "\r") {
      advance = 0;
    } else if (character === "\n") {
      return next;
    } else if (character === "^" && /[0-9]/.test(text[next] || "!")) {
      next += 1;
    } else {
      advance +=
        font.glyphs.find((glyph) => glyph.letter === character.charCodeAt(0))
          ?.advance || 0;
      if (index !== start && /\s/.test(character)) {
        boundary = next;
      }
    }
    if (boundary !== null && advance * scale > width) {
      return boundary;
    }
    index = next;
  }
  return text.length;
}

export function wrappedLines(text, font, scale, width, centred = false) {
  let limit = Math.trunc(width);
  const total = Math.floor(textWidth(text, font, scale) + 0.5);
  if (centred && width !== 0 && total > width) {
    const target = Math.ceil(total / width);
    for (
      let candidate = Math.ceil(total / target);
      candidate < limit;
      candidate += 8
    ) {
      if (wrappedLines(text, font, scale, candidate).length === target) {
        limit = candidate;
        break;
      }
    }
  }
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const chosen = lineEnd(text, start, font, scale, limit);
    lines.push(text.slice(start, chosen));
    start = chosen;
    while (start < text.length && /\s/.test(text[start])) {
      start += 1;
    }
  }
  return lines;
}

export function textLayout(item, viewport, fonts) {
  const font = fontFor(item, viewport, fonts);
  if (!font) {
    return null;
  }
  const scale = (number(item.scale) * 48) / font.height;
  const rect = clientRect(item);
  const height = Math.floor(number(item.scale) * 48 + 0.5);
  const lines = item.wrap
    ? wrappedLines(
        item.text,
        font,
        scale,
        Math.abs(rect[2]),
        (item.align & 3) === 1,
      )
    : [item.text];
  const alignX = item.align & 3;
  const alignY = item.align & 12;
  const border = item.border ? number(item.thickness) : 0;
  const startX = rect[0] + number(item.offset[0]) + border;
  let baseline = rect[1] + number(item.offset[1]) + border;
  if (alignY === 4) {
    baseline += height;
  } else if (alignY === 8) {
    baseline += (rect[3] + height) / 2;
  } else if (alignY === 12) {
    baseline += rect[3];
  }
  const calls = [];
  for (const line of lines) {
    const width = Math.floor(textWidth(line, font, scale) + 0.5);
    const x =
      startX +
      (alignX === 1
        ? (rect[2] - width) / 2
        : alignX === 2
          ? rect[2] - width
          : 0);
    calls.push({ text: line, x, baseline });
    if (item.wrap) {
      baseline += height + 2;
    }
  }
  return { font, scale, calls };
}

export function textQuads(item, viewport, fonts) {
  const layout = textLayout(item, viewport, fonts);
  if (!layout) {
    return [];
  }
  const { font, scale } = layout;
  const quads = [];
  const baseColour = rgba(item.foreground);
  for (const call of layout.calls) {
    const line = call.text;
    let x = call.x;
    let baseline = call.baseline;
    const lineX = x;
    let colour = baseColour;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === "^" && /[0-7]/.test(line[index + 1] || "!")) {
        const code = Number(line[index + 1]);
        colour = code === 7 ? baseColour : [...palette[code], baseColour[3]];
        index += 1;
        continue;
      }
      if (character === "\n" || character === "\r") {
        x = lineX;
        if (character === "\n") {
          baseline += font.height * scale;
        }
        continue;
      }
      const glyph = font.glyphs.find(
        (entry) => entry.letter === character.charCodeAt(0),
      );
      if (!glyph) {
        continue;
      }
      const quad = transformRect(
        [
          x + (glyph.x - 0.5) * scale,
          baseline + (glyph.y - 0.5) * scale,
          glyph.width * scale,
          glyph.height * scale,
        ],
        item,
        viewport,
      );
      if (item.textStyle === 3 || item.textStyle === 6) {
        const offset = item.textStyle === 3 ? 1 : 2;
        quads.push({
          rect: [quad[0] + offset, quad[1] + offset, quad[2], quad[3]],
          uv: glyph.uv,
          colour: [0, 0, 0, colour[3]],
          material: font.material,
        });
      }
      quads.push({ rect: quad, uv: glyph.uv, colour, material: font.material });
      const advance =
        item.textStyle === 128
          ? font.glyphs.find((entry) => entry.letter === 111).advance
          : glyph.advance;
      x += advance * scale;
    }
  }
  return quads;
}
