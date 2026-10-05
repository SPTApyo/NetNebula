import { Renderer, aim, WAVE_SPEED } from './gl.js';

const DIM_FACTOR = 0.25;

const SWAY = 0.006;

const REDUCED_MOTION =
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Must match the tokens of css/style.css.
const THEMES = {
  dark: {
    sky: [0.027, 0.039, 0.110],
    hot: [1.0, 0.77, 0.42],
    crest: [0.42, 0.50, 1.0],
    look: [0.66, 0.62, 0],
    label: [0.70, 0.66]
  },
  light: {
    sky: [0.933, 0.945, 0.965],
    hot: [0.153, 0.259, 0.839],
    crest: [1.0, 0.80, 0.52],
    look: [0.40, 0.72, 1],
    label: [0.36, 0.70]
  }
};

const nf = new Intl.NumberFormat('en-US');

let renderer = null;
let paused = false;
let graph = null;
let order = [];

document.addEventListener('DOMContentLoaded', main);

async function main() {
  bindTheme();
  try {
    const response = await fetch('graph.json');
    if (!response.ok) throw new Error(`graph.json: HTTP ${response.status}`);
    graph = await response.json();
    order = toNodes(graph);
    if (!order.length) {
      showOverlay({
        title: 'No map yet',
        text: 'The graph has not been built. Run pipeline/build_graph.py.'
      });
      return;
    }

    start();
    mountSearch();
    mountLabels();
    reveal();
    hideOverlay();
  } catch (error) {
    console.error(error);
    showOverlay({
      title: 'The map could not load',
      text: 'Check your connection, then retry.',
      action: { label: 'Retry', onClick: () => location.reload() }
    });
  }
}

function toNodes(g) {
  const nodes = g.names.map((name, i) => ({
    index: i,
    rank: i,
    name,
    hosts: g.hosts[i],
    group: g.groups[i],
    inn: g.in[i],
    out: g.out[i],
    x: g.xyz[i * 3],
    y: g.xyz[i * 3 + 1],
    z: g.xyz[i * 3 + 2],
    neighbours: new Set(),
    dim: 1
  }));
  for (let k = 0; k < g.edges.length; k += 2) {
    nodes[g.edges[k]].neighbours.add(g.edges[k + 1]);
    nodes[g.edges[k + 1]].neighbours.add(g.edges[k]);
  }
  return nodes;
}

function hueOf(group) {
  return ((group * 0.618033988749895 + 0.11) % 1) * 360;
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function cssColor(node, theme) {
  const [l, s] = THEMES[theme].label;
  const [r, g, b] = hslToRgb(hueOf(node.group), s, l);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function start() {
  const canvas = document.getElementById('orb');
  renderer = new Renderer(canvas, THEMES, currentTheme());
  renderer.onPick = onHover;
  upload();

  const { center, radius } = renderer.extent();
  renderer.eye.set([
    center[0] + radius * 0.55,
    center[1] + radius * 0.35,
    center[2] + renderer.distanceFor(radius)
  ]);
  renderer.lookAt(center);

  renderer.start();

  bindCamera(canvas);
  bindControls();

  if (new URLSearchParams(location.search).has('debug')) startDebug();
}

const CROWD_CELL = 0.012;

function crowding(nodes) {
  const bins = new Map();
  const key = (n) => `${Math.round(n.x / CROWD_CELL)},`
    + `${Math.round(n.y / CROWD_CELL)},`
    + `${Math.round(n.z / CROWD_CELL)}`;
  const keys = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    keys[i] = key(nodes[i]);
    bins.set(keys[i], (bins.get(keys[i]) || 0) + 1);
  }
  return (i) => 1 / Math.sqrt(bins.get(keys[i]));
}

function upload() {
  if (!renderer) return;

  const nodes = order;
  const count = nodes.length;
  const span = Math.log(1 + count);

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const tones = new Float32Array(count * 2);
  const ranks = new Float32Array(count);
  const dims = new Float32Array(count);
  const phases = new Float32Array(count);
  const amps = new Float32Array(count);

  const crowd = crowding(nodes);

  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    positions[i * 3] = node.x;
    positions[i * 3 + 1] = node.y;
    positions[i * 3 + 2] = node.z;
    tones[i * 2] = hueOf(node.group) / 360;
    tones[i * 2 + 1] = crowd(i);
    ranks[i] = i;
    dims[i] = node.dim;
    phases[i] = ((i * 2654435761) % 4096) / 4096 * Math.PI * 2;
    sizes[i] = 1.1 + 8.4 * Math.pow(1 - Math.log(1 + i) / span, 2);
    amps[i] = SWAY / (1 + Math.sqrt(node.neighbours.size) * 0.55);
  }

  const edges = graph.edges;
  const edgeCount = edges.length / 2;
  const edgePositions = new Float32Array(edgeCount * 6);
  const edgeTones = new Float32Array(edgeCount * 4);
  const edgeBoost = new Float32Array(edgeCount * 2);
  const edgeDims = new Float32Array(edgeCount * 2);
  const edgePhases = new Float32Array(edgeCount * 2);
  const edgeAmps = new Float32Array(edgeCount * 2);

  for (let e = 0; e < edgeCount; e++) {
    const a = edges[e * 2];
    const b = edges[e * 2 + 1];
    edgePositions.set(positions.subarray(a * 3, a * 3 + 3), e * 6);
    edgePositions.set(positions.subarray(b * 3, b * 3 + 3), e * 6 + 3);

    const ha = tones[a * 2];
    let hb = tones[b * 2];
    if (hb - ha > 0.5) hb -= 1;
    else if (ha - hb > 0.5) hb += 1;
    edgeTones[e * 4] = ha;
    edgeTones[e * 4 + 1] = tones[a * 2 + 1];
    edgeTones[e * 4 + 2] = hb;
    edgeTones[e * 4 + 3] = tones[b * 2 + 1];

    const crossing = nodes[a].group === nodes[b].group ? 0 : 1;
    const hub = 1 - Math.log(1 + Math.min(a, b)) / span;
    const boost = Math.min(1, (0.14 + 0.6 * hub * hub) * (crossing ? 0.45 : 1));
    const dim = Math.min(dims[a], dims[b]);
    for (const o of [0, 1]) {
      edgeBoost[e * 2 + o] = boost;
      edgeDims[e * 2 + o] = dim;
    }
    edgePhases[e * 2] = phases[a];
    edgePhases[e * 2 + 1] = phases[b];
    edgeAmps[e * 2] = amps[a];
    edgeAmps[e * 2 + 1] = amps[b];
  }

  renderer.upload({
    positions, sizes, tones, ranks, dims, phases, amps,
    edgePositions, edgeTones, edgeBoost, edgeDims, edgePhases, edgeAmps
  });
  renderer.nodes = nodes;
}

function bindCamera(canvas) {
  const pointers = new Map();
  let pinch = 0;
  let travel = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (!pointers.size) travel = 0;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    pinch = 0;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch') {
      const rect = canvas.getBoundingClientRect();
      renderer.mouse.x = e.clientX - rect.left;
      renderer.mouse.y = e.clientY - rect.top;
      renderer.mouse.moved = true;
    }
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const dx = e.clientX - last[0];
    const dy = e.clientY - last[1];
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    travel += Math.abs(dx) + Math.abs(dy);

    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) renderer.move((d - pinch) * 0.01 * renderer.travelScale(), 0, 0);
      pinch = d;
      return;
    }
    if (pointers.size > 1) return;

    renderer.yaw += dx * 0.004;
    renderer.pitch = Math.max(-1.45, Math.min(1.45, renderer.pitch + dy * 0.004));
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    pinch = 0;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    renderer.mouse.x = -1;
    renderer.mouse.moved = true;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.setFov(renderer.fov + e.deltaY * 0.0015);
  }, { passive: false });

  // Pick at the tap itself: touch has no hover.
  canvas.addEventListener('click', (e) => {
    if (travel > 8) return;
    const rect = canvas.getBoundingClientRect();
    renderer.mouse.x = e.clientX - rect.left;
    renderer.mouse.y = e.clientY - rect.top;
    const hit = renderer.pick(rect.width, rect.height);
    if (hit < 0) clearSelection();
    else if (renderer.marked === nodeAt(hit).rank) flyToNode(hit);
    else select(hit);
  });

  bindFlight();
}

function bindFlight() {
  const held = new Set();
  const KEYS = new Map([
    ['w', 'ahead'], ['z', 'ahead'], ['arrowup', 'ahead'],
    ['s', 'back'], ['arrowdown', 'back'],
    ['a', 'left'], ['q', 'left'], ['arrowleft', 'left'],
    ['d', 'right'], ['arrowright', 'right'],
    [' ', 'up'], ['shift', 'down']
  ]);

  const typing = () => document.activeElement
    && document.activeElement.tagName === 'INPUT';

  addEventListener('keydown', (e) => {
    if (typing()) return;
    const key = KEYS.get(e.key.toLowerCase());
    if (!key) return;
    held.add(key);
    e.preventDefault();
  });
  addEventListener('keyup', (e) => held.delete(KEYS.get(e.key.toLowerCase())));
  addEventListener('blur', () => held.clear());

  const velocity = [0, 0, 0];
  let last = performance.now();

  const tick = (now) => {
    requestAnimationFrame(tick);
    const dt = Math.min(now - last, 100) / 16.7;
    last = now;
    if (!renderer) return;

    const speed = renderer.travelScale() * 0.22;
    const want = [
      (held.has('ahead') ? 1 : 0) - (held.has('back') ? 1 : 0),
      (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0),
      (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0)
    ];

    let moving = false;
    for (let i = 0; i < 3; i++) {
      velocity[i] += (want[i] * speed - velocity[i]) * Math.min(1, 0.14 * dt);
      if (Math.abs(velocity[i]) > 1e-5) moving = true;
      else velocity[i] = 0;
    }
    if (moving) renderer.move(velocity[0] * dt, velocity[1] * dt, velocity[2] * dt);
  };
  requestAnimationFrame(tick);
}

function flyTo(point, distance = 0.45) {
  if (!renderer) return;
  const from = Float32Array.from(renderer.eye);
  const fromYaw = renderer.yaw;
  const fromPitch = renderer.pitch;

  const dx = point[0] - from[0];
  const dy = point[1] - from[1];
  const dz = point[2] - from[2];
  const span = Math.hypot(dx, dy, dz) || 1;
  const to = [
    point[0] - (dx / span) * distance,
    point[1] - (dy / span) * distance,
    point[2] - (dz / span) * distance
  ];

  const target = aim(to, point);

  let turn = ((target.yaw - fromYaw + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;

  if (REDUCED_MOTION) {
    renderer.eye.set(to);
    renderer.yaw = target.yaw;
    renderer.pitch = target.pitch;
    return;
  }

  const start = performance.now();
  requestAnimationFrame(function step(now) {
    const t = Math.min((now - start) / 1100, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    for (let i = 0; i < 3; i++) {
      renderer.eye[i] = from[i] + (to[i] - from[i]) * eased;
    }
    renderer.yaw = fromYaw + turn * eased;
    renderer.pitch = fromPitch + (target.pitch - fromPitch) * eased;
    if (t < 1) requestAnimationFrame(step);
  });
}

function flyToNode(index) {
  const node = nodeAt(index);
  if (!node) return;
  select(index);
  flyTo([node.x, node.y, node.z], 0.2);
}

function nodeAt(index) {
  return renderer && renderer.nodes ? renderer.nodes[index] : null;
}


function onHover(index) {
  const canvas = document.getElementById('orb');
  canvas.style.cursor = index >= 0 ? 'pointer' : 'default';

  const tip = document.getElementById('tip');
  const node = index >= 0 ? nodeAt(index) : null;
  if (!node) { tip.hidden = true; return; }

  tip.querySelector('.t-title').textContent = node.name;
  tip.querySelector('.t-url').textContent = `Rank ${nf.format(node.rank + 1)}`;
  tip.style.left = `${renderer.mouse.x + 16}px`;
  tip.style.top = `${renderer.mouse.y + 16}px`;
  tip.hidden = false;
}

function select(index) {
  const node = nodeAt(index);
  if (!node) return;
  renderer.marked = node.rank;

  const panel = document.getElementById('detail');
  panel.querySelector('.d-title').textContent = node.name;
  const link = panel.querySelector('.d-link');
  link.href = `https://${node.name}`;
  link.textContent = `Open ${node.name}`;
  panel.querySelector('.d-rank').textContent = nf.format(node.rank + 1);
  panel.querySelector('.d-hosts').textContent = nf.format(node.hosts);
  panel.querySelector('.d-in').textContent = nf.format(node.inn);
  panel.querySelector('.d-out').textContent = nf.format(node.out);

  const list = panel.querySelector('.d-near');
  list.replaceChildren(...[...node.neighbours].sort((a, b) => a - b).slice(0, 6)
    .map((i) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = order[i].name;
      button.onclick = () => flyToNode(i);
      item.append(button);
      return item;
    }));
  panel.querySelector('.d-near-block').hidden = !list.children.length;

  panel.hidden = false;
}

function clearSelection() {
  if (renderer) renderer.marked = -1;
  document.getElementById('detail').hidden = true;
}

function releaseLabel(id) {
  const months = id.replace(/^cc-main-/, '').split('-');
  const year = months.shift();
  const name = (m) => m.charAt(0).toUpperCase() + m.slice(1);
  return `${name(months[0])} to ${name(months[months.length - 1])} ${year}`;
}

function reveal() {
  if (matchMedia('(pointer: coarse)').matches) {
    document.getElementById('hint').textContent =
      'Drag to look, pinch to fly, tap a domain twice to focus';
  }
  for (const el of document.querySelectorAll('#readout, #controls, #hint')) {
    el.hidden = false;
  }
  setCount('stat-domains', order.length);
  setCount('stat-links', graph.edges.length / 2);
  document.getElementById('stat-source').textContent =
    `Common Crawl, ${releaseLabel(graph.release)}`;
}

function setCount(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const previous = Number(el.dataset.value || 0);
  el.dataset.value = String(value);

  if (REDUCED_MOTION || Math.abs(value - previous) < 3) {
    el.textContent = nf.format(value);
    return;
  }

  const start = performance.now();
  requestAnimationFrame(function step(now) {
    const t = Math.min((now - start) / 900, 1);
    const eased = 1 - Math.pow(1 - t, 4);
    el.textContent = nf.format(Math.round(previous + (value - previous) * eased));
    if (t < 1) requestAnimationFrame(step);
  });
}


function showOverlay({ title, text, action = null }) {
  const overlay = document.getElementById('overlay');
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-text').textContent = text;

  const button = document.getElementById('overlay-action');
  if (action) {
    button.querySelector('span').textContent = action.label;
    button.onclick = action.onClick;
    button.hidden = false;
  } else {
    button.hidden = true;
    button.onclick = null;
  }
  overlay.hidden = false;
}

function hideOverlay() {
  document.getElementById('overlay').hidden = true;
}


function bindControls() {
  document.getElementById('c-fit').onclick = fit;
  document.getElementById('c-random').onclick = focusRandom;
  document.getElementById('c-pause').onclick = togglePause;
  document.querySelector('.d-close').onclick = clearSelection;

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    switch (event.key.toLowerCase()) {
      case 't': fit(); break;
      case 'h': focusRandom(); break;
      case 'p': togglePause(); break;
      case 'l': toggleTheme(); break;
      case 'escape': clearSelection(); break;
      default: return;
    }
    event.preventDefault();
  });
}

function bindTheme() {
  for (const el of document.querySelectorAll('.surface')) el.dataset.theme = currentTheme();
  const button = document.getElementById('theme');
  button.setAttribute('aria-pressed', String(currentTheme() === 'light'));
  button.onclick = toggleTheme;
}

// Each surface carries its own theme and flips when a front reaches it,
// so stacked waves stay in step with the map.
function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  const box = document.getElementById('theme').getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;

  try { localStorage.setItem('netnebula:theme', next); } catch (error) { /* private mode */ }
  document.querySelector('meta[name="theme-color"]')
    .setAttribute('content', next === 'light' ? '#eef1f6' : '#070a1c');

  const animate = !REDUCED_MOTION;
  if (renderer) renderer.setTheme(next, x, y, animate);

  for (const el of document.querySelectorAll('.surface')) {
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const delay = animate ? Math.hypot(dx, dy) / WAVE_SPEED : 0;
    setTimeout(() => { el.dataset.theme = next; }, delay);
  }
  document.documentElement.dataset.theme = next;
  document.getElementById('theme').setAttribute('aria-pressed', String(next === 'light'));
}

const MAX_LABELS = 18;
const LABEL_POOL = 400;

function mountLabels() {
  const layer = document.getElementById('labels');
  const pool = [];
  const candidates = order.slice(0, LABEL_POOL);

  const project = () => {
    requestAnimationFrame(project);
    if (!renderer || !renderer.mvp || paused) return;

    const m = renderer.mvp;
    const width = layer.clientWidth;
    const height = layer.clientHeight;
    const now = performance.now();
    const placed = [];
    let used = 0;

    for (const a of candidates) {
      if (used >= MAX_LABELS) break;
      if (a.dim < 1) continue;
      const w = m[3] * a.x + m[7] * a.y + m[11] * a.z + m[15];
      if (w <= 0.05) continue;
      const sx = (m[0] * a.x + m[4] * a.y + m[8] * a.z + m[12]) / w;
      const sy = (m[1] * a.x + m[5] * a.y + m[9] * a.z + m[13]) / w;

      const px = (sx * 0.5 + 0.5) * width;
      const py = (0.5 - sy * 0.5) * height + 14;
      const half = a.name.length * 3.6 + 8;
      if (px - half < 8 || px + half > width - 8 || py < 8 || py > height - 20) continue;

      const box = [px - half, py - 8, px + half, py + 12];
      let free = true;
      for (const other of placed) {
        if (box[0] < other[2] && box[2] > other[0]
          && box[1] < other[3] && box[3] > other[1]) { free = false; break; }
      }
      if (!free) continue;
      placed.push(box);

      let el = pool[used];
      if (!el) {
        el = document.createElement('span');
        el.className = 'label';
        layer.appendChild(el);
        pool[used] = el;
      }
      el.textContent = a.name;
      el.style.color = cssColor(a, renderer.themeAt(px, py, now));
      el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
      el.style.opacity = '1';
      used += 1;
    }

    for (let i = used; i < pool.length; i++) pool[i].style.opacity = '0';
  };

  requestAnimationFrame(project);
}

function mountSearch() {
  const input = document.getElementById('search');
  const status = document.getElementById('search-count');
  const list = document.getElementById('search-results');
  let matches = [];

  const fold = (text) => text
    .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

  const apply = () => {
    const query = fold(input.value.trim());
    matches = [];
    for (const node of order) {
      const hit = !query || node.name.includes(query);
      node.dim = query && !hit ? DIM_FACTOR : 1;
      if (query && hit) matches.push(node);
    }

    status.textContent = query
      ? `${nf.format(matches.length)} ${matches.length === 1 ? 'domain' : 'domains'}`
      : '';
    list.replaceChildren(...matches.slice(0, 6).map((node) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = node.name;
      button.onclick = () => flyToNode(node.index);
      item.append(button);
      return item;
    }));
    upload();
  };

  let timer = 0;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 160);
  };

  input.onkeydown = (event) => {
    if (event.key === 'Escape') { input.value = ''; apply(); input.blur(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    apply();
    if (matches.length) flyToNode(matches[0].index);
  };
}

function startDebug() {
  const el = document.createElement('p');
  el.id = 'debug';
  document.body.appendChild(el);
  setInterval(() => {
    el.textContent =
      `${renderer.fps} fps, quality ${renderer.quality}/2,`
      + ` ${nf.format(renderer.count)} domains, ${nf.format(renderer.edges)} links,`
      + ` ${renderer.drawCalls} draw calls`;
  }, 500);
}

function fit() {
  if (!renderer) return;
  const { center, radius } = renderer.extent();
  flyTo(center, renderer.distanceFor(radius));
  clearSelection();
}

function focusRandom() {
  if (!renderer || !order.length) return;

  const node = order[Math.floor(Math.random() * order.length)];
  if (node) flyToNode(node.index);
}

function togglePause() {
  if (!renderer) return;
  paused = !paused;
  if (paused) renderer.stop(); else renderer.start();
  const button = document.getElementById('c-pause');
  button.querySelector('span').textContent = paused ? 'Resume' : 'Pause';
  button.setAttribute('aria-pressed', String(paused));
}

