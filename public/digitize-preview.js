/* Digitize 3D thread-tube preview. Raw WebGL2. No Three.js.
 * Mount: DigitizePreview.mount(canvas, payload)
 * payload: { widthMm, heightMm, stitches:[{x,y,cmd,colorIndex}], threads:[{hex}] }
 */
(function (root) {
  "use strict";

  function hexRgb(hex) {
    const h = String(hex || "#1e4482").replace("#", "");
    if (h.length !== 6) return [0.12, 0.27, 0.51];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }

  const VS = `#version 300 es
  layout(location=0) in vec3 aPos;
  layout(location=1) in vec3 aNrm;
  layout(location=2) in vec3 aCol;
  layout(location=3) in vec3 aTan;
  uniform mat4 uMVP;
  uniform mat4 uModel;
  out vec3 vN;
  out vec3 vC;
  out vec3 vW;
  out vec3 vT;
  void main() {
    vec4 w = uModel * vec4(aPos, 1.0);
    vW = w.xyz;
    vN = mat3(uModel) * aNrm;
    vT = mat3(uModel) * aTan;
    vC = aCol;
    gl_Position = uMVP * vec4(aPos, 1.0);
  }`;

  const FS = `#version 300 es
  precision highp float;
  in vec3 vN; in vec3 vC; in vec3 vW; in vec3 vT;
  uniform vec3 uLight;
  uniform vec3 uEye;
  uniform vec3 uAmbient;
  out vec4 frag;
  void main() {
    vec3 N = normalize(vN);
    vec3 T = normalize(vT);
    vec3 L = normalize(uLight);
    vec3 V = normalize(uEye - vW);
    float ndl = max(0.0, dot(N, L));
    vec3 H = normalize(L + V);
    float spec = pow(max(0.0, dot(N, H)), 36.0);
    float aniso = pow(max(0.0, 1.0 - abs(dot(T, H))), 3.4);
    float sheen = spec * 0.48 + aniso * 0.62;
    vec3 thread = vC * (0.16 + 0.84 * ndl) + vec3(1.0, 0.97, 0.90) * sheen;
    float rim = pow(1.0 - max(0.0, dot(N, V)), 2.4) * 0.22;
    thread += vC * rim + vec3(1.0, 0.95, 0.85) * rim * 0.25;
    frag = vec4(thread, 1.0);
  }`;

  const FSV = `#version 300 es
  precision highp float;
  in vec3 vN; in vec3 vC; in vec3 vW; in vec3 vT;
  uniform vec3 uLight;
  out vec4 frag;
  void main() {
    vec3 N = normalize(vN);
    float ndl = max(0.0, dot(N, normalize(uLight)));
    vec3 c = vC * (0.55 + 0.45 * ndl);
    frag = vec4(c, 1.0);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || "shader");
    }
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || "link");
    return p;
  }

  function mat4() { return new Float32Array(16); }
  function identity(o) {
    o.set([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); return o;
  }
  function perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect; out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }
  function lookAt(out, eye, c, up) {
    let zx = eye[0] - c[0], zy = eye[1] - c[1], zz = eye[2] - c[2];
    let zl = Math.hypot(zx, zy, zz) || 1; zx /= zl; zy /= zl; zz /= zl;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    let xl = Math.hypot(xx, xy, xz) || 1; xx /= xl; xy /= xl; xz /= xl;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }
  function mul(o, a, b) {
    const r = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        r[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
      }
    }
    o.set(r); return o;
  }

  function buildTubes(payload, until) {
    const stitches = payload.stitches || [];
    const threads = payload.threads || [{ hex: "#1e4482" }];
    const w = payload.widthMm || 25.4;
    const h = payload.heightMm || 25.4;
    const radius = 0.18;
    const sides = stitches.length > 40000 ? 5 : 6;
    const maxN = until == null ? stitches.length : Math.min(stitches.length, until);
    const pos = [], nrm = [], col = [], tan = [], idx = [];
    let last = null, colorIndex = 0;
    function rgbOf(i) {
      const t = threads[Math.max(0, Math.min(threads.length - 1, i))];
      return hexRgb(t && t.hex);
    }
    function addSeg(ax, ay, bx, by, rgb) {
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 0.04) return;
      const fx = dx / len, fy = dy / len;
      const px = -fy, py = fx;
      const z = 0.22;
      const base = pos.length / 3;
      for (let end = 0; end < 2; end++) {
        const cx = end ? bx : ax, cy = end ? by : ay;
        for (let s = 0; s < sides; s++) {
          const a = (s / sides) * Math.PI * 2;
          const ca = Math.cos(a), sa = Math.sin(a);
          const ox = px * ca * radius;
          const oy = py * ca * radius;
          const oz = sa * radius;
          pos.push(cx + ox, -(cy) + oy, z + oz);
          nrm.push(ox / radius, oy / radius, oz / radius);
          col.push(rgb[0], rgb[1], rgb[2]);
          tan.push(fx, -fy, 0);
        }
      }
      for (let s = 0; s < sides; s++) {
        const a = base + s;
        const b = base + ((s + 1) % sides);
        const c = base + sides + s;
        const d = base + sides + ((s + 1) % sides);
        idx.push(a, c, b, b, c, d);
      }
    }
    for (let i = 0; i < maxN; i++) {
      const s = stitches[i];
      if (s.cmd === "color") { colorIndex = s.colorIndex != null ? s.colorIndex : colorIndex + 1; last = null; continue; }
      const x = s.x * 0.1, y = s.y * 0.1;
      if (s.cmd === "jump" || s.cmd === "trim") { last = { x: x, y: y }; continue; }
      if (last) addSeg(last.x, last.y, x, y, rgbOf(s.colorIndex != null ? s.colorIndex : colorIndex));
      last = { x: x, y: y };
    }
    function fabric() {
      const y0 = 0.02;
      const p = [
        0, 0, y0,  w, 0, y0,  w, -h, y0,  0, -h, y0,
      ];
      const n = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
      const c = [];
      for (let i = 0; i < 4; i++) c.push(0.78, 0.72, 0.62);
      const t = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
      const fIdx = [0, 1, 2, 0, 2, 3];
      return { pos: p, nrm: n, col: c, tan: t, idx: fIdx };
    }
    return {
      tubes: {
        pos: new Float32Array(pos),
        nrm: new Float32Array(nrm),
        col: new Float32Array(col),
        tan: new Float32Array(tan),
        idx: new Uint32Array(idx),
      },
      fabric: fabric(),
      size: { w: w, h: h },
    };
  }

  function bufferMesh(gl, mesh) {
    function buf(data, target) {
      const b = gl.createBuffer();
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, gl.STATIC_DRAW);
      return b;
    }
    return {
      pos: buf(mesh.pos, gl.ARRAY_BUFFER),
      nrm: buf(mesh.nrm, gl.ARRAY_BUFFER),
      col: buf(mesh.col, gl.ARRAY_BUFFER),
      tan: buf(mesh.tan, gl.ARRAY_BUFFER),
      idx: buf(mesh.idx instanceof Uint32Array ? mesh.idx : new Uint32Array(mesh.idx), gl.ELEMENT_ARRAY_BUFFER),
      count: mesh.idx.length,
    };
  }

  function bindMesh(gl, mesh) {
    function attr(loc, b, n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
    }
    attr(0, mesh.pos, 3);
    attr(1, mesh.nrm, 3);
    attr(2, mesh.col, 3);
    attr(3, mesh.tan, 3);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idx);
  }

  function draw2d(ctx, payload, wpx, hpx, playT) {
    const w = payload.widthMm || 25.4, h = payload.heightMm || 25.4;
    const pad = 28;
    const scale = Math.min((wpx - pad * 2) / w, (hpx - pad * 2) / h);
    ctx.fillStyle = "#12161e";
    ctx.fillRect(0, 0, wpx, hpx);
    const ox = (wpx - w * scale) / 2, oy = (hpx - h * scale) / 2;
    ctx.fillStyle = "#c4b496";
    ctx.fillRect(ox, oy, w * scale, h * scale);
    ctx.fillStyle = "rgba(70,55,30,0.10)";
    for (let y = 0; y < h * scale; y += 3) ctx.fillRect(ox, oy + y, w * scale, 1);
    ctx.strokeStyle = "rgba(40,44,52,0.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(ox + w * scale / 2, oy + h * scale / 2, w * scale / 2 + 8, h * scale / 2 + 8, 0, 0, Math.PI * 2);
    ctx.stroke();
    const threads = payload.threads || [{ hex: "#1e4482" }];
    let last = null, colorIndex = 0, lastPt = null;
    const stitches = payload.stitches || [];
    const t = playT == null ? 1 : playT;
    const until = Math.max(1, Math.floor(stitches.length * t));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2.4, scale * 0.40);
    for (let i = 0; i < until; i++) {
      const s = stitches[i];
      if (s.cmd === "color") { colorIndex++; last = null; continue; }
      const x = ox + s.x * 0.1 * scale;
      const y = oy + s.y * 0.1 * scale;
      if (s.cmd === "jump" || s.cmd === "trim") { last = { x: x, y: y }; continue; }
      if (last) {
        const rgb = hexRgb((threads[s.colorIndex != null ? s.colorIndex : colorIndex] || threads[0]).hex);
        const r = Math.round(rgb[0] * 255), g = Math.round(rgb[1] * 255), b = Math.round(rgb[2] * 255);
        ctx.strokeStyle = "rgba(" + r + "," + g + "," + b + ",0.94)";
        ctx.shadowColor = "rgba(" + r + "," + g + "," + b + ",0.32)";
        ctx.shadowBlur = 2;
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
      last = { x: x, y: y };
      lastPt = last;
    }
    ctx.shadowBlur = 0;
    if (t < 0.999 && lastPt) {
      ctx.fillStyle = "#eee";
      ctx.beginPath(); ctx.arc(lastPt.x, lastPt.y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#c4281c";
      ctx.beginPath(); ctx.arc(lastPt.x, lastPt.y, 2.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  function DigitizePreview(canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.mode = "2d";
    const force2d = /(?:\?|&)mode=2d(?:&|$)/.test(location.search || "") || canvas.getAttribute("data-mode") === "2d";
    try {
      if (!force2d) this.gl = canvas.getContext("webgl2", { antialias: true, alpha: false, preserveDrawingBuffer: true });
    } catch (e) { this.gl = null; }
    if (!this.gl) {
      this.ctx2d = canvas.getContext("2d");
      this.yaw = 0.55; this.pitch = 0.72; this.dist = 0;
      this.payload = null; this.gpu = null;
      this.playing = false; this.playT = 1; this._playSpeed = 0.12;
      this._bindInput();
      return;
    }
    this.mode = "webgl2";
    const gl = this.gl;
    try {
    this.prog = program(gl, VS, FS);
    this.progFab = program(gl, VS, FSV);
    this.u = {
      mvp: gl.getUniformLocation(this.prog, "uMVP"),
      model: gl.getUniformLocation(this.prog, "uModel"),
      light: gl.getUniformLocation(this.prog, "uLight"),
      eye: gl.getUniformLocation(this.prog, "uEye"),
      amb: gl.getUniformLocation(this.prog, "uAmbient"),
    };
    this.uf = {
      mvp: gl.getUniformLocation(this.progFab, "uMVP"),
      model: gl.getUniformLocation(this.progFab, "uModel"),
      light: gl.getUniformLocation(this.progFab, "uLight"),
    };
    this.yaw = 0.55;
    this.pitch = 0.72;
    this.dist = 0;
    this.payload = null;
    this.gpu = null;
    this.playing = false;
    this.playT = 1;
    this._playSpeed = 0.12;
    this._bindInput();
    this._onResize();
    } catch (e) {
      this.gl = null;
      this.mode = "2d";
      this.ctx2d = canvas.getContext("2d");
      this.yaw = 0.55; this.pitch = 0.72; this.dist = 0;
      this.payload = null; this.gpu = null;
      this.playing = false; this.playT = 1; this._playSpeed = 0.12;
      this._bindInput();
    }
  }

  DigitizePreview.prototype._bindInput = function () {
    const c = this.canvas;
    let drag = false, lx = 0, ly = 0;
    c.addEventListener("pointerdown", (e) => { drag = true; lx = e.clientX; ly = e.clientY; c.setPointerCapture(e.pointerId); });
    c.addEventListener("pointerup", () => { drag = false; });
    c.addEventListener("pointermove", (e) => {
      if (!drag) return;
      this.yaw += (e.clientX - lx) * 0.008;
      this.pitch = Math.max(0.18, Math.min(1.35, this.pitch + (e.clientY - ly) * 0.008));
      lx = e.clientX; ly = e.clientY;
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.dist *= e.deltaY > 0 ? 1.08 : 0.92;
    }, { passive: false });
  };

  DigitizePreview.prototype._onResize = function () {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(2, Math.round((r.width || 640) * dpr));
    this.canvas.height = Math.max(2, Math.round((r.height || 420) * dpr));
    if (this.gl) this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  };

  DigitizePreview.prototype.setPayload = function (payload) {
    this.payload = payload;
    if (!this.gl) return;
    const mesh = buildTubes(payload, null);
    const maxDim = Math.max(mesh.size.w, mesh.size.h, 8);
    if (!this.dist) this.dist = maxDim * 1.55;
    this.gpu = {
      tubes: bufferMesh(this.gl, mesh.tubes),
      fabric: bufferMesh(this.gl, {
        pos: new Float32Array(mesh.fabric.pos),
        nrm: new Float32Array(mesh.fabric.nrm),
        col: new Float32Array(mesh.fabric.col),
        tan: new Float32Array(mesh.fabric.tan),
        idx: mesh.fabric.idx,
      }),
      size: mesh.size,
    };
  };

  DigitizePreview.prototype.recolor = function (threads) {
    if (!this.payload) return;
    this.payload = Object.assign({}, this.payload, { threads: threads });
    this.setPayload(this.payload);
  };

  DigitizePreview.prototype.setPlayhead = function (t) {
    this.playT = Math.max(0, Math.min(1, Number(t) || 0));
  };
  DigitizePreview.prototype.play = function (speed) {
    this.playing = true;
    if (speed) this._playSpeed = speed;
    if (this.playT >= 0.999) this.playT = 0;
  };
  DigitizePreview.prototype.pause = function () { this.playing = false; };

  DigitizePreview.prototype.frame = function () {
    this._onResize();
    if (this.playing) {
      this.playT += (this._playSpeed || 0.12) * 0.016;
      if (this.playT >= 1) { this.playT = 1; this.playing = false; }
    }
    if (!this.gl) {
      if (this.ctx2d && this.payload) draw2d(this.ctx2d, this.payload, this.canvas.width, this.canvas.height, this.playT);
      return;
    }
    const gl = this.gl;
    if (!this.gpu) return;
    this._onResize();
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.10, 0.12, 0.16, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const w = this.gpu.size.w, h = this.gpu.size.h;
    const cx = w / 2, cy = -h / 2, cz = 0.2;
    const eye = [
      cx + Math.cos(this.yaw) * Math.sin(this.pitch) * this.dist,
      cy + Math.cos(this.pitch) * this.dist * 0.35,
      cz + Math.sin(this.yaw) * Math.sin(this.pitch) * this.dist,
    ];
    const proj = perspective(mat4(), 0.7, this.canvas.width / this.canvas.height, 0.2, this.dist * 8);
    const view = lookAt(mat4(), eye, [cx, cy, cz], [0, 1, 0]);
    const mvp = mul(mat4(), proj, view);
    const model = identity(mat4());
    gl.useProgram(this.progFab);
    gl.uniformMatrix4fv(this.uf.mvp, false, mvp);
    gl.uniformMatrix4fv(this.uf.model, false, model);
    gl.uniform3f(this.uf.light, -0.25, 0.95, 0.55);
    bindMesh(gl, this.gpu.fabric);
    gl.drawElements(gl.TRIANGLES, this.gpu.fabric.count, gl.UNSIGNED_INT, 0);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.u.mvp, false, mvp);
    gl.uniformMatrix4fv(this.u.model, false, model);
    gl.uniform3f(this.u.light, -0.35, 0.9, 0.7);
    gl.uniform3f(this.u.eye, eye[0], eye[1], eye[2]);
    gl.uniform3f(this.u.amb, 0.12, 0.12, 0.14);
    bindMesh(gl, this.gpu.tubes);
    const count = Math.max(3, Math.floor(this.gpu.tubes.count * (this.playT == null ? 1 : this.playT)));
    const tri = count - (count % 3);
    gl.drawElements(gl.TRIANGLES, tri, gl.UNSIGNED_INT, 0);
  };

  DigitizePreview.prototype.start = function () {
    const self = this;
    function loop() { self.frame(); self._raf = requestAnimationFrame(loop); }
    if (!this._raf) this._raf = requestAnimationFrame(loop);
  };

  DigitizePreview.prototype.stop = function () {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  };

  function mount(canvas, payload) {
    const view = new DigitizePreview(canvas);
    if (payload) view.setPayload(payload);
    view.start();
    return view;
  }

  root.DigitizePreview = { mount: mount, Preview: DigitizePreview, hexRgb: hexRgb, draw2d: draw2d };
})(typeof window !== "undefined" ? window : globalThis);
