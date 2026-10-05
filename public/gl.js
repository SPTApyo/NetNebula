
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

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(v) {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

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

export function forward(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, -Math.sin(pitch), -Math.cos(yaw) * cp];
}

export function right(yaw) {
  return [Math.cos(yaw), 0, Math.sin(yaw)];
}

export function aim(eye, point) {
  const dx = point[0] - eye[0];
  const dy = point[1] - eye[1];
  const dz = point[2] - eye[2];
  const flat = Math.hypot(dx, dz) || 1e-5;
  return { yaw: Math.atan2(dx, -dz), pitch: Math.atan2(-dy, flat) };
}

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

const TONE = `
  vec3 toneOf(float hue, float l, float s) {
    vec3 base = clamp(
      abs(mod(fract(hue) * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
      0.0, 1.0);
    float chroma = (1.0 - abs(2.0 * l - 1.0)) * s;
    return (base - 0.5) * chroma + l;
  }`;

// Theme waves: wobbling circular fronts in screen pixels, oldest first.
// uWaves[i] = origin x, origin y, radius, unused. Look 0 is the base
// theme, look i + 1 the theme wave i brings. A look is tone lightness,
// saturation and how much a fragment covers instead of adding light.
const MAX_WAVES = 6;
const WAVE = `
  const int MAX_WAVES = ${MAX_WAVES};
  uniform highp vec4 uWaves[MAX_WAVES];
  uniform int uWaveCount;
  uniform highp float uClock;
  uniform vec3 uLooks[MAX_WAVES + 1];
  highp float frontOf(highp vec2 frag, highp vec4 wave) {
    highp vec2 d = frag - wave.xy;
    highp float a = atan(d.y, d.x);
    highp float swell = min(1.0, wave.z / 240.0);
    highp float wobble = 26.0 * sin(a * 5.0 + uClock * 2.3)
                 + 12.0 * sin(a * 9.0 - uClock * 3.7);
    return length(d) - wave.z - wobble * swell;
  }
  float maskOf(int i, highp vec2 frag) {
    return smoothstep(1.5, -1.5, frontOf(frag, uWaves[i]));
  }
  vec3 lookAt(highp vec2 frag) {
    vec3 look = uLooks[0];
    for (int i = 0; i < uWaveCount; i++) look = mix(look, uLooks[i + 1], maskOf(i, frag));
    return look;
  }
`;

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

const NEAR = `
  const float NEAR_CLIP = 0.004;
  const float NEAR_FULL = 0.16;

  float nearFade(float w) {
    return smoothstep(NEAR_CLIP, NEAR_FULL, w);
  }
`;

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
  in vec3 aStarColor;
  in vec2 aStar;
  uniform mat4 uMVP;
  uniform float uPx;
  uniform mediump float uStar;
  // mediump on both sides: the fragment reads the same uniform, and GLSL
  // requires the declared precision to match.
  uniform mediump float uGlow;
  uniform mediump float uGas;
  uniform float uMaxPoint;
  uniform float uMarked;
  ${DEPTH}
  ${NEAR}
  ${MOTION}
  out vec2 vTone;
  out float vDim;
  out float vMark;
  out float vDetail;
  out vec3 vStarColor;
  out float vLum;
  out float vSpike;
  void main() {
    gl_PointSize = 0.0;
    // Star map: size from hosts, glow from inbound links.
    float base = mix(aSize, aStar.y, uStar);
    vSpike = uStar * smoothstep(0.93, 1.0, aStar.x) * (1.0 - uGlow) * (1.0 - uGas);
    vMark = abs(aRank - uMarked) < 0.5 ? 1.0 : 0.0;

    // A first pass gives the depth, hence the on-screen size, hence the level
    // of detail, which modulates motion amplitude.
    vec4 probe = uMVP * vec4(aPos, 1.0);
    // Capped: size grows as 1/depth, and unbounded a node approached very
    // closely becomes a blurred smear that eats the screen.
    float size = clamp(
      uPx * (base + uGlow * 2.5 + vMark * 5.0) * (1.0 + 2.0 * vSpike) / max(probe.w, NEAR_CLIP),
      1.0, 58.0);
    // Gas: wide faint puffs whose overlap reads as a cloud.
    if (uGas > 0.5) {
      size = clamp(uPx * (aSize * 2.5 + 9.0) / max(probe.w, NEAR_CLIP), 2.0, uMaxPoint);
    }

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
    float weight = 0.62 + 0.38 * smoothstep(1.5, 6.5, base);

    // aDim carries the dimming requested by the search: what does not match
    // fades without ever leaving the map.
    vDim = depthFade(p.w) * nearFade(p.w) * weight * aDim;
    vTone = aTone;
    vStarColor = aStarColor;
    vLum = aStar.x;
  }`;

const DOT_FRAGMENT = `#version 300 es
  precision mediump float;
  in vec2 vTone;
  in float vDim;
  in float vMark;
  in float vDetail;
  in vec3 vStarColor;
  in float vLum;
  in float vSpike;
  uniform mediump float uStar;
  uniform vec3 uHots[${MAX_WAVES + 1}];
  uniform mediump float uGas;
  ${TONE}
  ${WAVE}
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
    // Small points render nearly solid, large ones keep a gradient.
    a = pow(a, mix(mix(1.2, 6.0, vDetail), 3.0, uGlow));
    if (uGas > 0.5) a = exp(-d * d * 4.0) * (1.0 - d);
    // Brightest stars: small core plus diffraction spikes.
    if (vSpike > 0.0) {
      vec2 q = abs(gl_PointCoord - 0.5) * 2.0;
      float core = pow(smoothstep(1.0, 0.0, d * 3.0), 1.5);
      float spikes = max(exp(-q.y * 60.0) * (1.0 - q.x), exp(-q.x * 60.0) * (1.0 - q.y));
      a = mix(a, max(core, spikes * 0.7), vSpike);
    }
    vec3 look = uLooks[0];
    vec3 hot = uHots[0];
    for (int i = 0; i < uWaveCount; i++) {
      float m = maskOf(i, gl_FragCoord.xy);
      look = mix(look, uLooks[i + 1], m);
      hot = mix(hot, uHots[i + 1], m);
    }
    vec3 tint = toneOf(vTone.x, look.x, look.y) * mix(1.0, vTone.y, 1.0 - look.z);
    // Gas keeps its cluster hue: each cluster reads as a galaxy.
    float stellar = uStar * (1.0 - uGas);
    tint = mix(tint, vStarColor * mix(1.0, 0.55, look.z), stellar);
    vec3 c = mix(tint, hot, vMark * (1.0 - uGas));
    float alpha = min(1.0, a * vDim * uAlpha * (1.0 + 3.0 * vMark)
      * mix(1.0, 0.9 + 2.2 * vLum, stellar));
    // Premultiplied: look.z 0 adds light, 1 paints over.
    frag = vec4(c * alpha, alpha * look.z);
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

    // Hue is interpolated, converted to RGB per fragment.
    vTone = aTone;
    // aBoost favours tree, crossing and junction links.
    vAlpha = (0.004 + 0.075 * aBoost) * uExposure
           * depthFade(p.w) * nearFade(p.w) * aDim;
  }`;

const LINE_FRAGMENT = `#version 300 es
  precision mediump float;
  in float vAlpha;
  in vec2 vTone;
  ${TONE}
  ${WAVE}
  out vec4 frag;
  void main() {
    vec3 look = lookAt(gl_FragCoord.xy);
    vec3 c = toneOf(vTone.x, look.x, look.y) * mix(1.0, vTone.y, 1.0 - look.z);
    float alpha = min(1.0, vAlpha * mix(1.0, 0.8, look.z));
    frag = vec4(c * alpha, alpha * look.z);
  }`;

// Orbits of the selected star: rings as lines, planets as discs.
// Each vertex is position, premultiplied colour and point size.
const ORBIT_VERTEX = `#version 300 es
  in vec3 aPos;
  in vec4 aColor;
  in float aSize;
  uniform mat4 uMVP;
  uniform float uPx;
  out vec4 vColor;
  void main() {
    gl_Position = uMVP * vec4(aPos, 1.0);
    gl_PointSize = clamp(uPx * aSize / max(gl_Position.w, 0.004), 2.0, 64.0);
    vColor = aColor;
  }`;

const ORBIT_FRAGMENT = `#version 300 es
  precision mediump float;
  in vec4 vColor;
  uniform float uDisc;
  out vec4 frag;
  void main() {
    float a = vColor.a;
    float d = length(gl_PointCoord - 0.5) * 2.0;
    // 1: crisp planet disc, 2: soft glow of the star.
    if (uDisc > 1.5) a *= exp(-d * d * 6.0) * (1.0 - d);
    else if (uDisc > 0.5) a *= smoothstep(1.0, 0.8, d);
    frag = vec4(vColor.rgb * a, a);
  }`;

const MAX_PLANETS = 8;
const RING_STEPS = 96;
const ORBIT_FLOATS = 8;

const SKY_VERTEX = `#version 300 es
  void main() {
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

// Background: theme colour swept by the waves, plus a far starfield and
// faint nebula clouds drawn from the view direction, so they turn with
// the camera. Each crest is a gaussian ridge lit from the upper left,
// which gives the wave its relief; fading ripples trail behind it.
const SKY_FRAGMENT = `#version 300 es
  precision highp float;
  uniform vec3 uSkies[${MAX_WAVES + 1}];
  uniform vec3 uCrests[${MAX_WAVES + 1}];
  uniform mat3 uInvRot;
  uniform vec2 uLens;
  uniform vec2 uViewport;
  uniform vec3 uEye;
  uniform vec3 uFlow;
  uniform float uSpeed;
  uniform float uTravel;
  uniform vec3 uDrift;
  ${WAVE}
  out vec4 frag;

  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x),
                   mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x),
                   mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }

  float fbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      sum += amp * noise(p);
      p = p * 2.03 + 11.7;
      amp *= 0.5;
    }
    return sum;
  }

  void main() {
    vec2 frag2 = gl_FragCoord.xy;
    vec3 sky = uSkies[0];
    vec3 look = uLooks[0];
    for (int i = 0; i < uWaveCount; i++) {
      vec4 wave = uWaves[i];
      float r = frontOf(frag2, wave);
      float m = smoothstep(1.5, -1.5, r);
      sky = mix(sky, uSkies[i + 1], m);
      look = mix(look, uLooks[i + 1], m);

      vec2 d = frag2 - wave.xy;
      float width = 34.0 + 0.04 * wave.z;
      float ridge = exp(-(r * r) / (width * width));
      float slope = -2.0 * r / width * ridge;
      vec3 normal = normalize(vec3(-normalize(d + 1e-4) * slope * 1.4, 1.0));
      float light = dot(normal, normalize(vec3(-0.45, 0.55, 0.7)));
      float behind = max(-r, 0.0);
      float ripple = sin(behind / 22.0 - uClock * 6.0) * exp(-behind / 160.0);
      sky += uCrests[i + 1] * (0.55 * ridge + 0.06 * ripple * m)
           + (light - 0.7) * ridge * 0.6;
    }

    vec2 ndc = frag2 / uViewport * 2.0 - 1.0;
    vec3 dir = normalize(uInvRot * vec3(ndc * uLens, -1.0));

    // Far clouds drift a little as the eye travels.
    float cloud = fbm(dir * 2.6 + uEye * 0.15);
    float tint = fbm(dir * 1.3 + 7.0);
    vec3 gas = mix(vec3(0.36, 0.20, 0.62), vec3(0.10, 0.42, 0.55), tint);
    float density = smoothstep(0.45, 0.85, cloud);

    // Twinkle: own rate and phase per star, two slow beats multiplied.
    vec3 cell = floor(dir * 160.0);
    vec3 offset = vec3(hash(cell + 1.3), hash(cell + 7.1), hash(cell + 3.7)) - 0.5;
    float rate = hash(cell + 19.3);
    float phase = hash(cell + 5.9) * 6.2832;
    float beat = sin(uClock * (0.13 + 0.3 * rate) + phase)
               * sin(uClock * (0.05 + 0.08 * offset.x + 0.04) + phase * 1.7);
    float star = step(0.975, hash(cell))
      * smoothstep(0.22, 0.0, length(fract(dir * 160.0) - 0.5 - offset * 0.5))
      * (0.35 + 0.25 * offset.y + 0.4 * (0.5 + 0.5 * beat));

    // Dust: shells of cells around the eye, so motes parallax as it moves.
    // Drift is travel in zoom units, so the dust keeps pace at any scale.
    float dust = 0.0;
    for (int i = 1; i <= 3; i++) {
      float depth = float(i) * 7.0;
      vec3 p = uDrift * 2.0 + dir * depth;
      vec3 c = floor(p);
      vec3 o = vec3(hash(c + 1.7), hash(c + 8.3), hash(c + 4.1));
      dust += step(0.86, hash(c + 5.0))
        * smoothstep(0.07, 0.0, length(fract(p) - o)) / float(i);
    }

    // Speed lines: rays around the flow axis, dashes running outward.
    // Each dash is drawn by lot: about a dozen a second at full speed.
    float streak = 0.0;
    if (uSpeed > 0.01) {
      vec3 e1 = normalize(cross(uFlow, abs(uFlow.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
      vec3 e2 = cross(uFlow, e1);
      float along = dot(dir, uFlow);
      float n = atan(dot(dir, e2), dot(dir, e1)) / 6.2832 * 120.0;
      float ray = floor(n);
      float h = hash(vec3(ray, 3.1, 7.7));
      float x = (1.0 - along) * (3.0 + 4.0 * hash(vec3(ray, 9.4, 1.3)))
              - uTravel * (0.6 + h) + h * 10.0;
      float lot = hash(vec3(ray, floor(x), 5.3));
      streak = step(0.993, lot)
        * smoothstep(0.1, 0.0, abs(fract(n) - 0.5) - 0.01)
        * smoothstep(0.0, 0.25, fract(x)) * smoothstep(0.7, 0.3, fract(x))
        * smoothstep(0.02, 0.3, 1.0 - along) * smoothstep(-0.3, 0.3, along)
        * uSpeed * uSpeed;
    }

    vec3 haze = mix(vec3(0.85, 0.88, 1.0), gas * 2.0, 0.35);
    vec3 night = gas * density * (0.16 + 0.1 * uSpeed)
               + vec3(0.85, 0.88, 1.0) * star * 0.7
               + haze * (dust * (0.25 + 0.6 * uSpeed) + streak * 0.7);
    vec3 day = (gas - 0.5) * density * 0.07
             - vec3(0.35, 0.3, 0.2) * (dust * (0.05 + 0.15 * uSpeed) + streak * 0.18);
    sky += mix(night, day, look.z);
    frag = vec4(clamp(sky, 0.0, 1.0), 1.0);
  }`;

const TARGET_MS = 16.7;

const DEFAULT_FOV = 0.85;
const MIN_FOV = 0.35;
const MAX_FOV = 1.6;

const NEAR_MIN = 0.004;

// Gas puffs drawn per quality level, best ranked domains first.
const GAS_POINTS = [0, 3000, 8000];

// Column-major inverse of the camera rotation built by view().
function inverseRotation(yaw, pitch) {
  const v = view(yaw, pitch, [0, 0, 0]);
  return new Float32Array([v[0], v[4], v[8], v[1], v[5], v[9], v[2], v[6], v[10]]);
}

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

const EXPOSE_SAMPLES = 512;
const EXPOSE_TARGET = 0.14;
const EXPOSE_MIN = 0.5;
const EXPOSE_MAX = 40;
const EXPOSE_RATE = 0.06;

const WAVE_UNIFORMS = ['uWaves', 'uWaveCount', 'uClock', 'uLooks'];

// Front speed in CSS pixels per millisecond, slower on small screens.
export function waveSpeed(width, height) {
  return 1.9 * Math.min(1, Math.hypot(width, height) / 2000);
}

export class Renderer {
  // themes: { name: { sky, hot, crest, look } }, colors in 0..1.
  constructor(canvas, themes, theme) {
    this.canvas = canvas;
    this.gl = context(canvas);
    if (!this.gl) throw new Error('WebGL2 unavailable');

    const gl = this.gl;
    this.themes = themes;
    this.base = theme;
    this.waves = [];

    this.dotProgram = compile(gl, DOT_VERTEX, DOT_FRAGMENT);
    this.lineProgram = compile(gl, LINE_VERTEX, LINE_FRAGMENT);
    this.skyProgram = compile(gl, SKY_VERTEX, SKY_FRAGMENT);
    this.orbitProgram = compile(gl, ORBIT_VERTEX, ORBIT_FRAGMENT);
    this.orbitU = this.uniforms(this.orbitProgram, ['uMVP', 'uPx', 'uDisc']);
    this.orbitData = new Float32Array((MAX_PLANETS * RING_STEPS * 2 + MAX_PLANETS + 1) * ORBIT_FLOATS);
    this.orbitBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.orbitBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.orbitData.byteLength, gl.DYNAMIC_DRAW);
    this.orbitVao = gl.createVertexArray();
    gl.bindVertexArray(this.orbitVao);
    for (const [name, size, offset] of [['aPos', 3, 0], ['aColor', 4, 3], ['aSize', 1, 7]]) {
      const loc = gl.getAttribLocation(this.orbitProgram, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, ORBIT_FLOATS * 4, offset * 4);
    }
    gl.bindVertexArray(null);
    this.dotU = this.uniforms(this.dotProgram,
      ['uMVP', 'uPx', 'uGlow', 'uGas', 'uMaxPoint', 'uMarked', 'uHots', 'uAlpha', 'uStar',
        'uTime', 'uSway', ...WAVE_UNIFORMS]);
    this.lineU = this.uniforms(this.lineProgram,
      ['uMVP', 'uPx', 'uTime', 'uSway', 'uExposure', ...WAVE_UNIFORMS]);
    this.skyU = this.uniforms(this.skyProgram,
      ['uSkies', 'uCrests', 'uInvRot', 'uLens', 'uViewport',
        'uEye', 'uFlow', 'uSpeed', 'uTravel', 'uDrift', ...WAVE_UNIFORMS]);
    this.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    this.emptyVao = gl.createVertexArray();

    this.buffers = [];
    this.vaos = [];
    this.count = 0;
    this.edges = 0;
    this.positions = null;
    this.sizes = null;
    this.ranks = null;

    this.exposure = 1;

    this.eye = new Float32Array([1.1, 0.7, 2.1]);
    this.lastEye = Float32Array.from(this.eye);
    this.flow = [0, 0, -1];
    this.speed = 0;
    this.travel = 0;
    this.drift = [0, 0, 0];
    const start = aim(this.eye, [0, 0, 0]);
    this.yaw = start.yaw;
    this.pitch = start.pitch;
    this.fov = DEFAULT_FOV;
    this.mvp = null;

    this.quality = 2;
    this.ema = TARGET_MS;
    this.holdUntil = 0;
    this.lastRetry = 0;
    this.auto = true;

    this.sway = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? 0 : 1;

    this.marked = -1;
    // Star map: target on/off, eased mix, links, orbits.
    this.starmap = false;
    this.star = 0;
    this.showLinks = false;
    this.timeScale = 1;
    this.orbitClock = 0;
    this.system = null;
    this.planets = [];
    this.onPick = null;
    this.mouse = { x: -1, y: -1, moved: false };
    this.reach = matchMedia('(pointer: coarse)').matches ? 28 : 16;
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

  release() {
    const gl = this.gl;
    for (const b of this.buffers) gl.deleteBuffer(b);
    for (const v of this.vaos) gl.deleteVertexArray(v);
    this.buffers = [];
    this.vaos = [];
  }

  upload({ positions, sizes, tones, ranks, dims, phases, amps,
           edgePositions, edgeTones, edgeBoost, edgeDims,
           edgePhases, edgeAmps, starColors, stars }) {
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
    this.attribute(this.dotProgram, 'aStarColor', starColors, 3);
    this.attribute(this.dotProgram, 'aStar', stars, 2);

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

      if (Math.abs(sx) > 1.15 || Math.abs(sy) > 1.15) continue;
      const size = Math.min(Math.max(px * (this.sizes[i] + 1.0) / w, 1), 58);

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

  // Orbit the given planets around center; null clears.
  // planets: [{ index, color: [r, g, b], size }], at most MAX_PLANETS.
  setSystem(center, planets, color = [1, 1, 1]) {
    if (!center) { this.system = null; this.planets = []; return; }
    const n = norm([Math.sin(center[0] * 91.7), 1.6, Math.cos(center[2] * 47.3)]);
    const e1 = norm(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]));
    const e2 = cross(n, e1);
    this.system = {
      center, n, e1, e2, color,
      orbits: planets.slice(0, MAX_PLANETS).map((p, k) => ({
        ...p,
        radius: 0.014 + 0.0085 * k,
        tilt: Math.sin(k * 12.9898 + center[1] * 78.233) * 0.22,
        phase: k * 2.4
      }))
    };
    this.planets = this.system.orbits.map((o) => ({ index: o.index, pos: [0, 0, 0] }));
  }

  orbitPoint(o, angle) {
    const { center, n, e1, e2 } = this.system;
    const c = Math.cos(angle) * o.radius;
    const s = Math.sin(angle) * o.radius;
    const ct = Math.cos(o.tilt);
    const st = Math.sin(o.tilt);
    return [0, 1, 2].map((i) => center[i] + c * e1[i] + s * (e2[i] * ct + n[i] * st));
  }

  // Kepler: angular speed falls as radius^-1.5.
  drawOrbits(dt, dpr, height) {
    if (!this.system || this.star < 0.01) return;
    const gl = this.gl;
    this.orbitClock += (dt / 1000) * this.timeScale * this.sway;
    const data = this.orbitData;
    const light = this.themes[this.theme].look[2];
    let v = 0;
    const put = (p, rgb, a, size) => {
      data.set([p[0], p[1], p[2], rgb[0], rgb[1], rgb[2], a, size], v * ORBIT_FLOATS);
      v += 1;
    };
    const ring = light ? [0.25, 0.3, 0.45] : [0.7, 0.75, 0.95];
    for (const o of this.system.orbits) {
      for (let k = 0; k < RING_STEPS; k++) {
        put(this.orbitPoint(o, (k / RING_STEPS) * 2 * Math.PI), ring, 0.16 * this.star, 0);
        put(this.orbitPoint(o, ((k + 1) / RING_STEPS) * 2 * Math.PI), ring, 0.16 * this.star, 0);
      }
    }
    const lines = v;
    this.system.orbits.forEach((o, k) => {
      const angle = o.phase + this.orbitClock * 0.9 * Math.pow(0.014 / o.radius, 1.5);
      const p = this.orbitPoint(o, angle);
      this.planets[k].pos = p;
      const rgb = light ? o.color.map((c) => c * 0.6) : o.color;
      put(p, rgb, 0.95 * this.star, o.size);
    });
    const planets = v - lines;
    put(this.system.center, this.system.color, 0.9 * this.star, 0.9);

    gl.useProgram(this.orbitProgram);
    gl.uniformMatrix4fv(this.orbitU.uMVP, false, this.mvp);
    gl.uniform1f(this.orbitU.uPx, dpr * height * 0.016);
    gl.bindVertexArray(this.orbitVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.orbitBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, v * ORBIT_FLOATS);
    gl.uniform1f(this.orbitU.uDisc, 0);
    gl.drawArrays(gl.LINES, 0, lines);
    gl.uniform1f(this.orbitU.uDisc, 1);
    gl.drawArrays(gl.POINTS, lines, planets);
    gl.uniform1f(this.orbitU.uDisc, 2);
    gl.drawArrays(gl.POINTS, lines + planets, 1);
  }

  // Eye speed from its real motion: 1 is full WASD speed.
  track(dt) {
    const d = [0, 1, 2].map((i) => this.eye[i] - this.lastEye[i]);
    this.lastEye.set(this.eye);
    const step = Math.hypot(...d);
    const scale = this.travelScale();
    const raw = step / (scale * 0.22 * Math.max(dt / 16.7, 0.1));
    this.speed += (Math.min(raw, 2) - this.speed) * 0.08;
    if (step > 1e-7) {
      this.flow = this.flow.map((f, i) => f + (d[i] / step - f) * 0.2);
      const n = Math.hypot(...this.flow) || 1;
      this.flow = this.flow.map((f) => f / n);
    }
    this.travel = (this.travel + step / scale) % 1000;
    this.drift = this.drift.map((v, i) => (v + d[i] / scale) % 1000);
  }

  pick(width, height) {
    if (!this.positions || !this.mvp) return -1;
    const m = this.mvp;
    let best = -1;
    let bestDistance = this.reach * this.reach;

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
    if (this.star < 0.5) return best;
    for (const p of this.planets) {
      const [x, y, z] = p.pos;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= NEAR_MIN) continue;
      const px = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * width;
      const py = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5) * height;
      const d = (px - this.mouse.x) ** 2 + (py - this.mouse.y) ** 2;
      if (d < bestDistance) { best = p.index; bestDistance = d; }
    }
    return best;
  }

  adapt(dt, now) {
    if (dt < 100) this.ema += (dt - this.ema) * 0.06;
    if (!this.auto || now < this.holdUntil) return;

    if (this.ema > TARGET_MS * 1.15 && this.quality > 0) {
      this.quality -= 1;
      this.holdUntil = now + 1500;
      this.lastRetry = now;

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

    const seconds = now / 1000;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      * [0.7, 0.85, 1][this.quality];
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (this.canvas.width !== (width * dpr | 0)) this.canvas.width = width * dpr | 0;
    if (this.canvas.height !== (height * dpr | 0)) this.canvas.height = height * dpr | 0;

    this.mvp = multiply(

      perspective(this.fov, width / height, 0.004, 80),
      view(this.yaw, this.pitch, this.eye));

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.DEPTH_TEST);

    const waves = this.waveState(now, dpr, height);
    const themes = [this.base, ...this.waves.map((w) => w.theme)]
      .map((name) => this.themes[name]);
    const pack = (key) => new Float32Array(themes.flatMap((t) => t[key]));
    const setWave = (u) => {
      gl.uniform4fv(u.uWaves, waves);
      gl.uniform1i(u.uWaveCount, this.waves.length);
      gl.uniform1f(u.uClock, (now / 1000) % 1000);
      gl.uniform3fv(u.uLooks, pack('look'));
    };

    gl.disable(gl.BLEND);
    gl.useProgram(this.skyProgram);
    setWave(this.skyU);
    gl.uniform3fv(this.skyU.uSkies, pack('sky'));
    gl.uniform3fv(this.skyU.uCrests, pack('crest'));
    gl.uniformMatrix3fv(this.skyU.uInvRot, false, inverseRotation(this.yaw, this.pitch));
    const tan = Math.tan(this.fov / 2);
    gl.uniform2f(this.skyU.uLens, tan * width / height, tan);
    gl.uniform2f(this.skyU.uViewport, this.canvas.width, this.canvas.height);
    this.track(dt);
    const { radius } = this.extent();
    gl.uniform3f(this.skyU.uEye, this.eye[0] / radius, this.eye[1] / radius, this.eye[2] / radius);
    gl.uniform3fv(this.skyU.uFlow, this.flow);
    gl.uniform1f(this.skyU.uSpeed, Math.min(this.speed, 1.5) * this.sway);
    gl.uniform1f(this.skyU.uTravel, this.travel);
    gl.uniform3fv(this.skyU.uDrift, this.drift);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    this.star += ((this.starmap ? 1 : 0) - this.star) * (this.sway ? Math.min(1, dt / 300) : 1);
    const linkFade = this.showLinks ? 1 : 1 - this.star;
    if (this.edges && linkFade > 0.01) {
      gl.useProgram(this.lineProgram);
      setWave(this.lineU);
      gl.uniformMatrix4fv(this.lineU.uMVP, false, this.mvp);
      gl.uniform1f(this.lineU.uPx, dpr * height * 0.016);

      gl.uniform1f(this.lineU.uExposure, this.exposure * linkFade);
      gl.uniform1f(this.lineU.uTime, seconds);
      gl.uniform1f(this.lineU.uSway, this.sway);
      gl.bindVertexArray(this.lineVao);
      gl.drawArrays(gl.LINES, 0, this.edges * 2);
    }

    gl.useProgram(this.dotProgram);
    gl.uniformMatrix4fv(this.dotU.uMVP, false, this.mvp);
    gl.uniform1f(this.dotU.uTime, seconds);
    gl.uniform1f(this.dotU.uSway, this.sway);

    gl.uniform1f(this.dotU.uPx, dpr * height * 0.016);
    gl.uniform1f(this.dotU.uMarked, this.marked);
    gl.uniform1f(this.dotU.uStar, this.star);
    this.expose(dpr, height);
    setWave(this.dotU);
    gl.uniform3fv(this.dotU.uHots, pack('hot'));
    gl.uniform1f(this.dotU.uMaxPoint, this.maxPoint);
    gl.uniform1f(this.dotU.uGas, 0);
    gl.bindVertexArray(this.dotVao);

    if (this.quality >= 1) {
      gl.uniform1f(this.dotU.uGas, 1);
      gl.uniform1f(this.dotU.uGlow, 0);
      gl.uniform1f(this.dotU.uAlpha, 0.012 * this.exposure);
      gl.drawArrays(gl.POINTS, 0, Math.min(this.count, GAS_POINTS[this.quality]));
      gl.uniform1f(this.dotU.uGas, 0);
    }

    if (this.quality >= 2) {
      gl.uniform1f(this.dotU.uGlow, 1);
      gl.uniform1f(this.dotU.uAlpha, 0.018 * this.exposure);
      gl.drawArrays(gl.POINTS, 0, this.count);
    }
    gl.uniform1f(this.dotU.uGlow, 0);

    gl.uniform1f(this.dotU.uAlpha, 0.1 * this.exposure);
    gl.drawArrays(gl.POINTS, 0, this.count);

    this.drawOrbits(dt, dpr, height);
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

  // Theme the latest wave leads to.
  get theme() {
    return this.waves.length ? this.waves[this.waves.length - 1].theme : this.base;
  }

  // Send a theme wave from (x, y) in CSS pixels; returns its duration.
  // Waves stack: a new one starts while older ones still travel.
  setTheme(theme, x, y, animate) {
    if (theme === this.theme) return 0;
    if (!animate) {
      this.base = theme;
      this.waves = [];
      return 0;
    }
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const reach = Math.max(Math.hypot(x, y), Math.hypot(width - x, y),
      Math.hypot(x, height - y), Math.hypot(width - x, height - y)) + 80;
    const speed = waveSpeed(width, height);
    this.waves.push({ theme, start: performance.now(), x, y, reach, speed });
    // ponytail: beyond MAX_WAVES the oldest lands at once
    if (this.waves.length > MAX_WAVES) this.base = this.waves.shift().theme;
    return reach / speed;
  }

  // Theme shown at (x, y) CSS pixels, wobble ignored.
  themeAt(x, y, now = performance.now()) {
    let theme = this.base;
    for (const w of this.waves) {
      if (Math.hypot(x - w.x, y - w.y) < (now - w.start) * w.speed) theme = w.theme;
    }
    return theme;
  }

  // Retire waves that covered the screen; pack the rest for the GPU.
  waveState(now, dpr, height) {
    while (this.waves.length && (now - this.waves[0].start) * this.waves[0].speed > this.waves[0].reach) {
      this.base = this.waves.shift().theme;
    }
    const packed = new Float32Array(MAX_WAVES * 4);
    this.waves.forEach((w, i) => {
      packed.set([w.x * dpr, (height - w.y) * dpr, (now - w.start) * w.speed * dpr, 0], i * 4);
    });
    return packed;
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

  get focal() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    return (this.canvas.height || dpr * 900) / (2 * Math.tan(this.fov / 2));
  }

  setFov(fov) {
    this.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, fov));
  }

  move(ahead, side, up) {
    const f = forward(this.yaw, this.pitch);
    const r = right(this.yaw);
    for (let i = 0; i < 3; i++) {
      this.eye[i] += f[i] * ahead + r[i] * side;
    }
    this.eye[1] += up;
  }

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

  travelScale() {
    const { center, radius } = this.extent();
    const d = Math.hypot(
      this.eye[0] - center[0], this.eye[1] - center[1], this.eye[2] - center[2]);
    return Math.max(radius * 0.02, Math.min(d, radius * 4) * 0.1);
  }

  distanceFor(radius) {
    return (radius * 1.25) / Math.tan(this.fov / 2);
  }

  lookAt(point) {
    const a = aim(this.eye, point);
    this.yaw = a.yaw;
    this.pitch = a.pitch;
  }

  get drawCalls() {
    return 1 + (this.edges ? 1 : 0) + (this.quality >= 2 ? 3 : this.quality);
  }

  get fps() {
    return Math.round(1000 / Math.max(this.ema, 0.1));
  }
}
