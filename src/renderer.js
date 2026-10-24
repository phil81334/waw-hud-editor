import { number, rgba } from "./document.js";
import { clientRect, transformRect, textQuads } from "./layout.js";

export class Renderer {
  constructor(canvas, resources) {
    this.canvas = canvas;
    this.resources = resources;
    this.textures = new Map();
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) {
      throw new Error(
        "WebGL2 is unavailable. Update your graphics driver to use the HUD canvas.",
      );
    }
    this.gl = gl;
    const vertex = `#version 300 es
      in vec2 point;
      uniform vec4 rect;
      uniform vec4 frame;
      uniform vec2 resolution;
      uniform vec4 imageUv;
      out vec2 uv;
      void main() {
        vec2 screen = frame.xy + (rect.xy + point * rect.zw) * frame.z;
        gl_Position = vec4(screen.x / resolution.x * 2.0 - 1.0, 1.0 - screen.y / resolution.y * 2.0, 0.0, 1.0);
        uv = mix(imageUv.xy, imageUv.zw, point);
      }`;
    const fragment = `#version 300 es
      precision highp float;
      uniform sampler2D image;
      uniform vec4 tint;
      uniform int alphaTest;
      in vec2 uv;
      out vec4 colour;
      void main() {
        colour = texture(image, uv) * tint;
        if ((alphaTest == 1 && colour.a <= 0.0) || (alphaTest == 3 && colour.a < 128.0 / 255.0)) {
          discard;
        }
      }`;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      return shader;
    };
    this.program = gl.createProgram();
    gl.attachShader(this.program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(this.program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(this.program));
    }
    gl.useProgram(this.program);
    gl.bindVertexArray(gl.createVertexArray());
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const point = gl.getAttribLocation(this.program, "point");
    gl.enableVertexAttribArray(point);
    gl.vertexAttribPointer(point, 2, gl.FLOAT, false, 0, 0);
    this.uniforms = {};
    for (const name of [
      "rect",
      "frame",
      "resolution",
      "imageUv",
      "tint",
      "alphaTest",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
    this.white = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DITHER);
  }

  clearTextures() {
    for (const texture of this.textures.values()) {
      this.gl.deleteTexture(texture);
    }
    this.textures.clear();
  }

  releaseTexture(name) {
    const texture = this.textures.get(name);
    if (texture) {
      this.gl.deleteTexture(texture);
      this.textures.delete(name);
    }
  }

  texture(material) {
    if (this.textures.has(material.name)) {
      return this.textures.get(material.name);
    }
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    if (material.element) {
      // Local design references use browser-decoded pixels. The native IWI
      // upload/sampling path below remains unchanged.
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        material.element,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.set(material.name, texture);
      return texture;
    }
    material.levels.forEach((level, index) => {
      gl.texImage2D(
        gl.TEXTURE_2D,
        index,
        gl.RGBA8,
        level.width,
        level.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        level.pixels instanceof Uint8Array
          ? level.pixels
          : new Uint8Array(level.pixels),
      );
    });
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAX_LEVEL,
      material.levels.length - 1,
    );
    const filter = material.sampler & 7;
    const mip = (material.sampler >> 3) & 3;
    const linear = filter !== 1;
    let min = linear ? gl.LINEAR : gl.NEAREST;
    if (mip === 1) {
      min = linear ? gl.LINEAR_MIPMAP_NEAREST : gl.NEAREST_MIPMAP_NEAREST;
    } else if (mip === 2) {
      min = linear ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_LINEAR;
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MAG_FILTER,
      linear ? gl.LINEAR : gl.NEAREST,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_S,
      material.sampler & 32 ? gl.CLAMP_TO_EDGE : gl.REPEAT,
    );
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_WRAP_T,
      material.sampler & 64 ? gl.CLAMP_TO_EDGE : gl.REPEAT,
    );
    if (this.anisotropy && filter >= 3) {
      const maximum = gl.getParameter(
        this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT,
      );
      gl.texParameterf(
        gl.TEXTURE_2D,
        this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(maximum, filter === 3 ? 2 : 4),
      );
    }
    this.textures.set(material.name, texture);
    return texture;
  }

  blend(material) {
    const gl = this.gl;
    if (material?.blend === "replace") {
      gl.disable(gl.BLEND);
      return;
    }
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    const modes = {
      blend: [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA],
      add: [gl.ONE, gl.ONE],
      multiply: [gl.ZERO, gl.SRC_COLOR],
      screen: [gl.ONE_MINUS_DST_COLOR, gl.ONE],
    };
    const factors = modes[material?.blend || "blend"];
    const preserveAlpha =
      material?.blend === "add" || material?.blend === "screen";
    gl.blendFuncSeparate(
      ...factors,
      preserveAlpha ? gl.ZERO : gl.ONE_MINUS_DST_ALPHA,
      gl.ONE,
    );
  }

  quad(rect, colour, material = null, uv = [0, 0, 1, 1], polygon = null) {
    const gl = this.gl;
    if (rect.some((value) => !Number.isFinite(value))) {
      return;
    }
    this.blend(material);
    gl.bindTexture(
      gl.TEXTURE_2D,
      material ? this.texture(material) : this.white,
    );
    gl.uniform4fv(this.uniforms.rect, rect);
    gl.uniform4fv(this.uniforms.imageUv, uv);
    gl.uniform4fv(this.uniforms.tint, colour);
    gl.uniform1i(this.uniforms.alphaTest, material?.alphaTest || 0);
    const vertices = polygon || [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 2);
  }

  render(project, frame) {
    const gl = this.gl;
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (
      this.canvas.width !== Math.round(width * dpr) ||
      this.canvas.height !== Math.round(height * dpr)
    ) {
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0.075, 0.095, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.uniforms.resolution, width, height);
    gl.uniform4f(this.uniforms.frame, frame.x, frame.y, frame.scale, 0);
    this.quad(
      [0, 0, project.viewport.width, project.viewport.height],
      [0.13, 0.17, 0.2, 1],
    );
    const left = Math.max(0, frame.x * dpr);
    const bottom = Math.max(
      0,
      this.canvas.height -
        (frame.y + project.viewport.height * frame.scale) * dpr,
    );
    const right = Math.min(
      this.canvas.width,
      (frame.x + project.viewport.width * frame.scale) * dpr,
    );
    const top = Math.min(
      this.canvas.height,
      this.canvas.height - frame.y * dpr,
    );
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(
      left,
      bottom,
      Math.max(0, right - left),
      Math.max(0, top - bottom),
    );
    const background = project.background;
    const picture =
      background?.visible && this.resources.localImages?.get(background.path);
    if (picture) {
      const { width, height } = picture.levels[0];
      const scale = Math.min(
        project.viewport.width / width,
        project.viewport.height / height,
      );
      const w = width * scale;
      const h = height * scale;
      this.quad(
        [
          (project.viewport.width - w) / 2,
          (project.viewport.height - h) / 2,
          w,
          h,
        ],
        [1, 1, 1, background.opacity],
        picture,
      );
    }
    for (const item of project.items) {
      if (!item.visible || item.hidden) {
        continue;
      }
      const client = clientRect(item);
      const inner = client.slice();
      const thickness = item.border ? number(item.thickness) : 0;
      if (item.border) {
        inner[0] += thickness;
        inner[1] += thickness;
        inner[2] -= thickness + 1;
        inner[3] -= thickness + 1;
      }
      if (item.kind === "rectangle") {
        this.quad(
          transformRect(inner, item, project.viewport),
          rgba(item.fill),
        );
      } else if (item.kind === "image") {
        const material = item.localImage
          ? this.resources.localImages?.get(item.localImage.path)
          : this.resources.materials.get(item.material);
        if (material) {
          const uv = [
            inner[2] < 0 ? 1 : 0,
            inner[3] < 0 ? 1 : 0,
            inner[2] < 0 ? 0 : 1,
            inner[3] < 0 ? 0 : 1,
          ];
          inner[2] = Math.abs(inner[2]);
          inner[3] = Math.abs(inner[3]);
          this.quad(
            transformRect(inner, item, project.viewport),
            rgba(item.foreground),
            material,
            uv,
          );
        }
      }
      this.border(item, client, project.viewport);
      if (item.kind === "text") {
        for (const glyph of textQuads(
          item,
          project.viewport,
          this.resources.fonts,
        )) {
          const material = this.resources.materials.get(glyph.material);
          if (material) {
            this.quad(glyph.rect, glyph.colour, material, glyph.uv);
          }
        }
      }
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  border(item, rect, viewport) {
    const [x, y, w, h] = rect;
    const b = number(item.thickness);
    const colour = rgba(item.borderColor);
    const draw = (quad) =>
      this.quad(transformRect(quad, item, viewport), colour);
    if ([1, 2].includes(item.border)) {
      draw([x, y, w, b]);
      draw([x, y + h - b, w, b]);
    }
    if (item.border === 1) {
      draw([x, y + b, b, h - 2 * b]);
      draw([x + w - b, y + b, b, h - 2 * b]);
    } else if (item.border === 3) {
      draw([x, y, b, h]);
      draw([x + w - b, y, b, h]);
    } else if (item.border === 5 || item.border === 6) {
      const polygons = [
        [
          [x, y],
          [x + w, y],
          [x + w - b, y + b],
          [x + b, y + b],
        ],
        [
          [x, y],
          [x + b, y + b],
          [x + b, y + h - b],
          [x, y + h],
        ],
        [
          [x, y + h],
          [x + b, y + h - b],
          [x + w - b, y + h - b],
          [x + w, y + h],
        ],
        [
          [x + w, y],
          [x + w, y + h],
          [x + w - b, y + h - b],
          [x + w - b, y + b],
        ],
      ];
      polygons.forEach((polygon, index) => {
        const shade = index < 2 === (item.border === 5) ? 1 : 0.6;
        const tint = colour.map((value, channel) =>
          channel === 3 ? value : value * shade,
        );
        const points = polygon.map(([px, py]) =>
          transformRect([px, py, 0, 0], item, viewport).slice(0, 2),
        );
        this.quad(
          [0, 0, 1, 1],
          tint,
          null,
          [0, 0, 1, 1],
          [
            ...points[0],
            ...points[1],
            ...points[2],
            ...points[0],
            ...points[2],
            ...points[3],
          ],
        );
      });
    }
  }
}
