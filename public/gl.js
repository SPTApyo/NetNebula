/**
 * NetNebula WebGL2 rendering engine.
 *
 * Replaces 3d-force-graph, which created one Object3D per node AND per link:
 * measured at 3010 nodes, 30126 draw calls and 0.9 frames per second on an
 * integrated GPU. The cost was in the number of objects, never in the geometry.
 *
 * Here the whole scene fits in three draw calls, whatever the node count:
 *
 *   1. gl.LINES: every edge, one buffer
 *   2. gl.POINTS: wide pale halo
 *   3. gl.POINTS: crisp dot on top
 *
 * The two point passes give the glow without post-processing or a second
 * render target. Nodes carry no geometry: `gl_PointSize` in the vertex shader,
 * disc drawn in the fragment shader from `gl_PointCoord`.
 */

/* ------------------------------------------------------------------- context */

/**
 * Open a WebGL2 context, from the most demanding request to the barest.
 *
 * `powerPreference: "high-performance"` asks for the discrete GPU; on a
 * dual-card machine, or with a partially supported open driver, the browser
 * sometimes prefers to render nothing rather than arbitrate. So we ask again
 * without it, then without anything.
 */
export function context(canvas) {
  const tries = [
    { antialias: false, alpha: false, powerPreference: 'high-performance' },
    { antialias: false, alpha: false },
    {}
  ];
  for (const options of tries) {
    const gl = canvas.getContext('webgl2', options);
    if (gl) return gl;
  }
  return null;
}

/* -------------------------------------------------------------- 4x4 matrices */

function multiply(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0
  ]);
}

/**
 * Free camera: a position in the world and a look direction.
 *
 * Orbiting a target meant dragging that target everywhere you wanted to see
 * something. Here you move through the volume as through a space, which is the
 * right gesture for crossing a map.
 */
function view(yaw, pitch, eye) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const ry = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
  const rx = new Float32Array([1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, 0, 0, 0, 1]);
  const move = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
    -eye[0], -eye[1], -eye[2], 1
  ]);
  return multiply(rx, multiply(ry, move));
}

// The three functions below are the exact inverse of `view` above. Deriving
// them by eye gives a camera that looks somewhere other than where it is
// pointed, with nothing to flag the mistake.

/** Unit vector of the gaze, from yaw and pitch. */
export function forward(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, -Math.sin(pitch), -Math.cos(yaw) * cp];
}

/** Unit vector towards the right of the screen. */
export function right(yaw) {
  return [Math.cos(yaw), 0, Math.sin(yaw)];
}

/** Yaw and pitch that look from `eye` towards `point`. */
export function aim(eye, point) {
  const dx = point[0] - eye[0];
  const dy = point[1] - eye[1];
  const dz = point[2] - eye[2];
  const flat = Math.hypot(dx, dz) || 1e-5;
  return { yaw: Math.atan2(dx, -dz), pitch: Math.atan2(-dy, flat) };
}

/* ------------------------------------------------------------------- shaders */

function compile(gl, vertexSource, fragmentSource) {
  const shader = (type, source) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, shader(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p));
  }
  return p;
}

// Breathing.
//
// Every node oscillates on its own phase, drawn from its identifier. A link
// endpoint carries the phase and amplitude of the node it touches: without
// that the strokes come away from their ends and the map falls apart.
//
// Detail controls amplitude; distant motion stays calm.
// while nearby nodes remain alive. It also
// grows towards the leaves: a heavily linked junction is anchored, an isolated
// page floats at the end of its branch.

// Hue -> RGB, at the same saturation and lightness as the CSS colour scheme.
//
// Interpolating in hue rather than in RGB is the whole point: between a red
// and a blue, the RGB average is a muddy grey, the hue average is a violet.
// That is what we want to see on a link crossing two domains.
const TONE = `
  const float TONE_S = 0.62;
  const float TONE_L = 0.66;
  vec3 toneOf(float hue) {
    vec3 base = clamp(
      abs(mod(fract(hue) * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
      0.0, 1.0);
    float chroma = (1.0 - abs(2.0 * TONE_L - 1.0)) * TONE_S;
    return (base - 0.5) * chroma + TONE_L;
  }`;

const MOTION = `
  uniform float uTime;
  uniform float uSway;

  vec3 breathe(vec3 p, float phase, float amp) {
    vec3 wobble = vec3(
      sin(uTime * 0.61 + phase),
      sin(uTime * 0.47 + phase * 1.7),
      sin(uTime * 0.53 + phase * 2.3));
    return p + wobble * amp * uSway;
  }
`;

// Close near plane, and the fade that makes it bearable.
//
// A point is only a vertex: past the near plane the GPU rejects it whole. A
// real object would have extent and would slide off to the side; the point
// vanishes outright. It cannot have extent without geometry,
// so it is faded out on approach instead, which reads as passing through
// rather than as a disappearing trick.
const NEAR = `
  const float NEAR_CLIP = 0.004;
  const float NEAR_FULL = 0.16;

  float nearFade(float w) {
    return smoothstep(NEAR_CLIP, NEAR_FULL, w);
  }
`;

// Depth attenuation.
//
// Nothing ever disappears because of where the camera is: a landmark that
// fades while you steer towards it makes navigation impossible. What is far is
// merely darker, and sharpens again as you approach.
//
// The floor is what separates atmospheric perspective from a vanishing act:
// even at the edge of the map, a node stays perceptible.
const DEPTH = `
  const float DEPTH_NEAR = 0.30;
  const float DEPTH_FAR = 7.0;
  const float DEPTH_FLOOR = 0.16;

  float depthFade(float w) {
    float t = smoothstep(DEPTH_FAR, DEPTH_NEAR, w);
    return DEPTH_FLOOR + (1.0 - DEPTH_FLOOR) * t;
  }
`;

const DOT_VERTEX = `#version 300 es
  in vec3 aPos;
  in float aSize;
  in float aRank;
  in float aDim;
  in float aPhase;
  in float aAmp;
  in vec2 aTone;
  uniform mat4 uMVP;
  uniform float uPx;
  // mediump on both sides: the fragment reads the same uniform, and GLSL
  // requires the declared precision to match.
  uniform mediump float uGlow;
  uniform float uMarked;
  ${DEPTH}
  ${NEAR}
  ${MOTION}
  ${TONE}
  out vec3 vTint;
  out float vDim;
  out float vMark;
  out float vDetail;
  void main() {
    gl_PointSize = 0.0;
    vMark = abs(aRank - uMarked) < 0.5 ? 1.0 : 0.0;

    // A first pass gives the depth, hence the on-screen size, hence the level
    // of detail, which modulates motion amplitude.
    vec4 probe = uMVP * vec4(aPos, 1.0);
    // Capped: size grows as 1/depth, and unbounded a node approached very
    // closely becomes a blurred smear that eats the screen.
    float size = clamp(
      uPx * (aSize + uGlow * 2.5 + vMark * 5.0) / max(probe.w, NEAR_CLIP),
      1.0, 58.0);

    // Detail neither opens nor closes anything: it enriches. Coming closer
    // adds shape and motion, it never takes a landmark away.
    vDetail = smoothstep(3.0, 24.0, size);

    vec4 p = uMVP * vec4(breathe(aPos, aPhase, aAmp * (0.25 + 0.75 * vDetail)), 1.0);
    gl_Position = p;
    gl_PointSize = size;

    // Junctions shine, dust stays faint.
    //
    // Without this weighting, fifteen hundred points of equal intensity add up
    // and burn the heart of a cluster to white. Weighting by the number of
    // links says what darkening layer by layer would say, and says it more
    // truthfully for a graph.
    //
    // The floor guarantees an isolated page stays visible: it fades, it does
    // not disappear.
    float weight = 0.62 + 0.38 * smoothstep(1.5, 6.5, aSize);

    // aDim carries the dimming requested by the search: what does not match
    // fades without ever leaving the map.
    vDim = depthFade(p.w) * nearFade(p.w) * weight * aDim;
    vTint = toneOf(aTone.x) * aTone.y;
  }`;

const DOT_FRAGMENT = `#version 300 es
  precision mediump float;
  in vec3 vTint;
  in float vDim;
  in float vMark;
  in float vDetail;
  uniform vec3 uHot;
  uniform float uAlpha;
  // Declared in both stages: it is the same uniform, and the fragment needs it
  // to know which of the two passes it is drawing.
  uniform mediump float uGlow;
  out vec4 frag;
  void main() {
    // Disc drawn in the fragment shader: no sphere geometry is ever sent.
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a = smoothstep(1.0, 0.0, d);

    // The falloff has to follow the size of the point.
    //
    // A two-pixel point only samples gl_PointCoord at half its radius: with a
    // steep falloff it keeps one hundredth of its energy and disappears. That
    // is what kept the map black until a cluster piled hundreds of points on
    // the same spot.
    //
    // Small points render nearly solid.
    // the large ones, which have the room, keep a gradient. The glow stays
    // soft in every case: that is its job.
    a = pow(a, mix(mix(1.2, 6.0, vDetail), 3.0, uGlow));
    vec3 c = mix(vTint, uHot, vMark);
    frag = vec4(c, a * vDim * uAlpha * (1.0 + 3.0 * vMark));
  }`;

const LINE_VERTEX = `#version 300 es
  in vec3 aPos;
  in float aRank;
  in float aDim;
  in float aBoost;
  in float aPhase;
  in float aAmp;
  in vec2 aTone;
  uniform mat4 uMVP;
  uniform float uPx;
  uniform float uExposure;
  ${DEPTH}
  ${NEAR}
  ${MOTION}
  out float vAlpha;
  out vec2 vTone;
  void main() {
    // Each endpoint carries the phase and amplitude of the node it touches:
    // the stroke stays glued to both its ends while breathing, instead of
    // coming away from them.
    vec4 probe = uMVP * vec4(aPos, 1.0);
    float detail = smoothstep(3.0, 24.0, uPx * 2.0 / max(probe.w, NEAR_CLIP));
    vec4 p = uMVP * vec4(breathe(aPos, aPhase, aAmp * (0.25 + 0.75 * detail)), 1.0);
    gl_Position = p;

    // Each endpoint carries the hue of its node, and the rasteriser
    // Interpolate both values directly.
    // Wikipedia to YouTube passes through violet rather than through a grey.
    // The conversion happens in the fragment shader, otherwise the
    // interpolation would fall back to RGB. A link inside one domain stays a
    // Flat hue recedes; crossings stand out.
    // of the map, so it is given more intensity too.
    vTone = aTone;
    // Fifty thousand additive strokes converging in a tight cluster burn its
    // heart to white. The opacity of a link has to be reasoned about for
    // density, not for one isolated stroke.
    // aBoost says how much the edge deserves to be seen: tree structure,
    // domain crossing, junction. Seven times the opacity between a structural
    // Crossings add depth to the map.
    // hairball, where everything is drawn with the same force.
    vAlpha = (0.004 + 0.075 * aBoost) * uExposure
           * depthFade(p.w) * nearFade(p.w) * aDim;
  }`;

const LINE_FRAGMENT = `#version 300 es
  precision mediump float;
  in float vAlpha;
  in vec2 vTone;
  ${TONE}
  out vec4 frag;
  void main() { frag = vec4(toneOf(vTone.x) * vTone.y, vAlpha); }`;

/* ----------------------------------------------------------------- rendering */

const TARGET_MS = 16.7; // 60 frames per second

// Initial vertical field of view, and the bounds of the scroll wheel.
const DEFAULT_FOV = 0.85;
const MIN_FOV = 0.35;
const MAX_FOV = 1.6;

const NEAR_MIN = 0.004;

/** Same curve as the GLSL function of the same name. */
function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

// Automatic exposure: target screen coverage, bounds, and the rate at which
// exposure reaches its target (per frame).
const EXPOSE_SAMPLES = 512;
const EXPOSE_TARGET = 0.14;
const EXPOSE_MIN = 0.5;
const EXPOSE_MAX = 40;
const EXPOSE_RATE = 0.06;

export class Renderer {
  constructor(canvas, palette) {
    this.canvas = canvas;
    this.gl = context(canvas);
    if (!this.gl) throw new Error('WebGL2 unavailable');

    const gl = this.gl;
    this.ink = palette.ink;
    this.hot = palette.hot;
    this.background = palette.background;

    this.dotProgram = compile(gl, DOT_VERTEX, DOT_FRAGMENT);
    this.lineProgram = compile(gl, LINE_VERTEX, LINE_FRAGMENT);
    this.dotU = this.uniforms(this.dotProgram,
      ['uMVP', 'uPx', 'uGlow', 'uMarked', 'uHot', 'uAlpha', 'uTime', 'uSway']);
    this.lineU = this.uniforms(this.lineProgram,
      ['uMVP', 'uPx', 'uTime', 'uSway', 'uExposure']);

    this.buffers = [];
    this.vaos = [];
    this.count = 0;
    this.edges = 0;
    this.positions = null;
    this.sizes = null;
    this.ranks = null;

    // Automatic exposure; see expose().
    this.exposure = 1;

    // Free camera: a position and a gaze. The gaze is computed, never guessed
    // A fixed yaw would aim beside the map.
    this.eye = new Float32Array([1.1, 0.7, 2.1]);
    const start = aim(this.eye, [0, 0, 0]);
    this.yaw = start.yaw;
    this.pitch = start.pitch;
    this.fov = DEFAULT_FOV;
    this.mvp = null;

    // Governor: 2 = full fidelity, 0 = the gentlest. It never removes a node,
    // it softens the rendering.
    this.quality = 2;
    this.ema = TARGET_MS;
    this.holdUntil = 0;
    this.lastRetry = 0;
    this.auto = true;

    // Cut to zero under prefers-reduced-motion: the map holds still instead of
    // breathing.
    this.sway = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0 : 1;

    this.marked = -1;
    this.onPick = null;
    this.mouse = { x: -1, y: -1, moved: false };
    this.running = false;
    this.idleAt = 0;
  }

  uniforms(program, names) {
    return Object.fromEntries(
      names.map((n) => [n, this.gl.getUniformLocation(program, n)]));
  }

  attribute(program, name, data, size) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, name);
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    }
    this.buffers.push(buffer);
  }

  /** Hand the buffers of the previous scene back to the driver. */
  release() {
    const gl = this.gl;
    for (const b of this.buffers) gl.deleteBuffer(b);
    for (const v of this.vaos) gl.deleteVertexArray(v);
    this.buffers = [];
    this.vaos = [];
  }

  /**
   * Upload the scene. Everything is static afterwards: not a single buffer
   * write while the graph does not change.
   *
   * `rank` orders nodes from the most connected to the least. The governor
   * uses it as a cut-off: leaves go first, never the junctions that carry the
   * structure.
   */
  upload({ positions, sizes, tones, ranks, dims, phases, amps,
           edgePositions, edgeTones, edgeBoost, edgeDims,
           edgePhases, edgeAmps }) {
    const gl = this.gl;
    this.release();

    this.count = positions.length / 3;
    this._extent = null;
    this.edges = edgePositions.length / 6;
    this.positions = positions;
    this.sizes = sizes;
    this.ranks = ranks;
    this.dims = dims;

    this.dotVao = gl.createVertexArray();
    this.vaos.push(this.dotVao);
    gl.bindVertexArray(this.dotVao);
    this.attribute(this.dotProgram, 'aPos', positions, 3);
    this.attribute(this.dotProgram, 'aSize', sizes, 1);
    this.attribute(this.dotProgram, 'aTone', tones, 2);
    this.attribute(this.dotProgram, 'aRank', ranks, 1);
    this.attribute(this.dotProgram, 'aDim', dims, 1);
    this.attribute(this.dotProgram, 'aPhase', phases, 1);
    this.attribute(this.dotProgram, 'aAmp', amps, 1);

    this.lineVao = gl.createVertexArray();
    this.vaos.push(this.lineVao);
    gl.bindVertexArray(this.lineVao);
    this.attribute(this.lineProgram, 'aPos', edgePositions, 3);
    this.attribute(this.lineProgram, 'aTone', edgeTones, 2);
    this.attribute(this.lineProgram, 'aBoost', edgeBoost, 1);
    this.attribute(this.lineProgram, 'aDim', edgeDims, 1);
    this.attribute(this.lineProgram, 'aPhase', edgePhases, 1);
    this.attribute(this.lineProgram, 'aAmp', edgeAmps, 1);

    gl.bindVertexArray(null);
  }

  /**
   * Automatic exposure.
   *
   * Additive blending makes screen brightness depend on how many points
   * overlap: an opacity that suits a cluster leaves an isolated page
   * invisible, and the reverse burns the heart of clusters to white. No fixed
  * Exposure adapts to the visible range.
   * actually on screen.
   *
   * Covered area is estimated over a sample of constant size: measuring it
   * exactly would mean reading the framebuffer back, which synchronises the
   * GPU and costs more than all the rest of the rendering.
   *
   * The smoothing is not cosmetic: without it, exposure follows every camera
   * movement and the map pulses.
   */
  expose(dpr, height) {
    if (!this.positions || !this.count || !this.mvp) return;

    const m = this.mvp;
    const px = dpr * height * 0.016;
    const stride = Math.max(1, Math.ceil(this.count / EXPOSE_SAMPLES));

    let area = 0;
    let taken = 0;
    for (let i = 0; i < this.count; i += stride) {
      taken += 1;
      const x = this.positions[i * 3];
      const y = this.positions[i * 3 + 1];
      const z = this.positions[i * 3 + 2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0.004) continue;
      const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      const sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      // A margin: a point whose centre leaves the frame still lights its edge,
      // and counting it avoids an exposure jump as it crosses.
      if (Math.abs(sx) > 1.15 || Math.abs(sy) > 1.15) continue;
      const size = Math.min(Math.max(px * (this.sizes[i] + 1.0) / w, 1), 58);
      // What counts is not the square occupied but the light it emits: the
      // fragment falloff empties nearly all of a large disc. Without this
      // correction a few nearby nodes saturate the estimate and exposure stays
      // pinned to its floor while the map is black. The integral of
      // pow(smoothstep, n) over the disc is 2 / ((n+1)(n+2)); n is the
      // exponent chosen by the fragment shader.
      const n = 1.2 + 4.8 * smoothstep(3, 24, size);
      area += size * size * (2 / ((n + 1) * (n + 2)));
    }

    if (!taken) return;
    const covered = (area * this.count / taken)
      / (this.canvas.width * this.canvas.height);
    const want = Math.min(Math.max(EXPOSE_TARGET / Math.max(covered, 1e-4),
                                   EXPOSE_MIN), EXPOSE_MAX);
    this.exposure += (want - this.exposure) * EXPOSE_RATE;
  }

  /**
   * Find the node nearest the cursor by projecting the positions onto the
   * screen. No GPU readback, no object to intersect: one loop over a
   * Float32Array, and only when the mouse has moved.
   */
  pick(width, height) {
    if (!this.positions || !this.mvp) return -1;
    const m = this.mvp;
    let best = -1;
    let bestDistance = 16 * 16;

    for (let i = 0; i < this.count; i++) {
      const x = this.positions[i * 3];
      const y = this.positions[i * 3 + 1];
      const z = this.positions[i * 3 + 2];
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= NEAR_MIN) continue;
      const sx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      const sy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      const px = (sx * 0.5 + 0.5) * width;
      const py = (0.5 - sy * 0.5) * height;
      const d = (px - this.mouse.x) ** 2 + (py - this.mouse.y) ** 2;
      if (d < bestDistance) { best = i; bestDistance = d; }
    }
    return best;
  }

  /**
   * Aim for 60 frames per second by degrading fidelity, never content.
   *
   * The previous version hid nodes. Because it reacted to the frame rate, it
  * Batch hidden nodes while the camera rests.
   * disappearing for no perceptible reason, which is exactly what this design
   * has tried to banish from the start.
   *
   * Three steps: the glow first, which costs one draw call and a lot of fill;
   * then pixel density. A softer map is still a whole map.
   */
  adapt(dt, now) {
    if (dt < 100) this.ema += (dt - this.ema) * 0.06; // hidden tab: ignored
    if (!this.auto || now < this.holdUntil) return;

    if (this.ema > TARGET_MS * 1.15 && this.quality > 0) {
      this.quality -= 1;
      this.holdUntil = now + 1500;
      this.lastRetry = now;
    // Guard delay before trying again: without it the governor would step back
    // up immediately after stepping down, and oscillate between two states.
    } else if (this.ema < TARGET_MS * 0.9 && this.quality < 2
               && now - this.lastRetry > 5000) {
      this.quality += 1;
      this.lastRetry = now;
      this.holdUntil = now + 1500;
    }
  }

  frame(now) {
    if (!this.running) return;
    requestAnimationFrame((t) => this.frame(t));

    const dt = now - this.last;
    this.last = now;
    this.adapt(dt, now);

    const gl = this.gl;
    // Past 1.5 the visual gain does not pay for the pixels to fill.
    const seconds = now / 1000;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      * [0.7, 0.85, 1][this.quality];
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (this.canvas.width !== (width * dpr | 0)) this.canvas.width = width * dpr | 0;
    if (this.canvas.height !== (height * dpr | 0)) this.canvas.height = height * dpr | 0;

    this.mvp = multiply(
      // Very close near plane: with the depth test disabled its precision does
      // not matter here, and pushing it back costs nothing.
      perspective(this.fov, width / height, 0.004, 80),
      view(this.yaw, this.pitch, this.eye));

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(this.background[0], this.background[1], this.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // No depth test, additive blending: nothing to sort, and the layers stack
    // up into volume.
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    if (this.edges) {
      gl.useProgram(this.lineProgram);
      gl.uniformMatrix4fv(this.lineU.uMVP, false, this.mvp);
      gl.uniform1f(this.lineU.uPx, dpr * height * 0.016);
      // Links follow the same exposure as points: otherwise a sparse view
      // would show legible nodes joined by invisible strokes.
      gl.uniform1f(this.lineU.uExposure, this.exposure);
      gl.uniform1f(this.lineU.uTime, seconds);
      gl.uniform1f(this.lineU.uSway, this.sway);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, this.edges * 2);
    }

    gl.useProgram(this.dotProgram);
    gl.uniformMatrix4fv(this.dotU.uMVP, false, this.mvp);
    gl.uniform1f(this.dotU.uTime, seconds);
    gl.uniform1f(this.dotU.uSway, this.sway);
    // Point size factor. Too low and the nodes become pinpricks, taking all
    // the colour of the map with them.
    gl.uniform1f(this.dotU.uPx, dpr * height * 0.016);
    gl.uniform1f(this.dotU.uMarked, this.marked);
    this.expose(dpr, height);
    gl.uniform3fv(this.dotU.uHot, this.hot);
    gl.bindVertexArray(this.dotVao);

    // Two passes: wide, very pale halo, then the crisp dot. Glow with no
    // post-processing and no second render target.
    // The glow is the first luxury to drop when the machine struggles: one
    // draw call and a great deal of fill, for a halo.
    if (this.quality >= 2) {
      gl.uniform1f(this.dotU.uGlow, 1);
      gl.uniform1f(this.dotU.uAlpha, 0.018 * this.exposure);
      gl.drawArrays(gl.POINTS, 0, this.count);
    }
    gl.uniform1f(this.dotU.uGlow, 0);
    // Additive blending has no ceiling: fifty overlapping points sum their
    // opacities. With no layers to divide by, the base opacity is what has to
    // be low. At 0.5 the heart of a cluster burned to white.
    gl.uniform1f(this.dotU.uAlpha, 0.1 * this.exposure);
    gl.drawArrays(gl.POINTS, 0, this.count);

    gl.bindVertexArray(null);

    if (this.mouse.moved) {
      this.mouse.moved = false;
      const hit = this.pick(width, height);
      if (hit !== this.hovered) {
        this.hovered = hit;
        if (this.onPick) this.onPick(hit);
      }
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  stop() {
    this.running = false;
  }

  /**
   * Projection factor: how many pixels a radius of one unit spans when placed
   * one unit deep. This is what converts a world size into a screen size.
   */
  get focal() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    return (this.canvas.height || dpr * 900) / (2 * Math.tan(this.fov / 2));
  }

  setFov(fov) {
    this.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, fov));
  }

  /** Move the camera in its own frame: ahead, right, up. */
  move(ahead, side, up) {
    const f = forward(this.yaw, this.pitch);
    const r = right(this.yaw);
    for (let i = 0; i < 3; i++) {
      this.eye[i] += f[i] * ahead + r[i] * side;
    }
    this.eye[1] += up;
  }

  /**
   * Extent actually occupied by what is loaded.
   *
   * Framing on an assumed radius gave a tiny nebula in the middle of a void:
   * while a single domain has been surveyed, the map occupies only a fifth of
   * the available volume.
   */
  extent() {
    if (this._extent) return this._extent;
    if (!this.positions || !this.count) return { center: [0, 0, 0], radius: 1 };
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < this.count; i++) {
      cx += this.positions[i * 3];
      cy += this.positions[i * 3 + 1];
      cz += this.positions[i * 3 + 2];
    }
    cx /= this.count; cy /= this.count; cz /= this.count;

    let radius = 0;
    for (let i = 0; i < this.count; i++) {
      const d = Math.hypot(
        this.positions[i * 3] - cx,
        this.positions[i * 3 + 1] - cy,
        this.positions[i * 3 + 2] - cz);
      if (d > radius) radius = d;
    }
    this._extent = { center: [cx, cy, cz], radius: radius || 1 };
    return this._extent;
  }

  /**
   * Travel step scaled to how far away the content is.
   *
   * A fixed step takes fifty gestures to cross a map seen from afar, and
   * shoots straight through a cluster seen from close up. Speed follows the
   * distance to the content, as in any 3D viewer.
   */
  travelScale() {
    const { center, radius } = this.extent();
    const d = Math.hypot(
      this.eye[0] - center[0], this.eye[1] - center[1], this.eye[2] - center[2]);
    return Math.max(radius * 0.02, Math.min(d, radius * 4) * 0.1);
  }

  /** Distance from which a sphere of this radius fits in the frame. */
  distanceFor(radius) {
    return (radius * 1.25) / Math.tan(this.fov / 2);
  }

  /** Point the gaze at a place in the world. */
  lookAt(point) {
    const a = aim(this.eye, point);
    this.yaw = a.yaw;
    this.pitch = a.pitch;
  }

  /** Draw calls actually issued: 2, or 3 with the glow pass. */
  get drawCalls() {
    return (this.edges ? 1 : 0) + (this.quality >= 2 ? 2 : 1);
  }

  /** Observed frames per second, for the diagnostic readout. */
  get fps() {
    return Math.round(1000 / Math.max(this.ema, 0.1));
  }
}
