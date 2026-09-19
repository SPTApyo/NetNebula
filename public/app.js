/**
 * NetNebula viewer.
 *
 * Reads the `pages` collection and renders it as a 3D nebula. Read-only: every
 * write goes through the crawler, via the Admin SDK, which bypasses the
 * security rules entirely.
 *
 * Rendering uses gl.js and WebGL2.
 * scene. What is left here is loading, state and the interface.
 *
 * Loading happens at two levels, the way an open-world game shows distant
 * terrain only in low definition and loads nearby regions in detail:
 *
 *   The skeleton: shallow pages loaded once.
 *   shape, the one seen from afar.
 *
 *   The regions: nearby cells load on approach.
 *   is aimed at, in one `where('cell','in',[...])` query. Firestore caps `in`
 *   at 30 values: a 3x3x3 neighbourhood just fits, and that is what fixes the
 *   shape of the loading.
 *
 * None of this would be possible if positions came out of a client-side
 * simulation: that needs the whole graph. The crawler places every page once
 * and for all, and the position becomes an indexable field.
 */

import { Renderer, aim } from './gl.js';

// Firebase web configuration. This is public by design: the API key is an
// identifier, not a credential, and every access is gated by firestore.rules
// (public reads, no client write). There is no build step here, so moving it
// out of the source would only add one for no security gain.
const firebaseConfig = {
  apiKey: "AIzaSyC6v4zKmLOLv4YJWUskjiuTtbLzxjH87IE",
  authDomain: "netnebula-eb9eb.firebaseapp.com",
  projectId: "netnebula-eb9eb",
  storageBucket: "netnebula-eb9eb.firebasestorage.app",
  messagingSenderId: "131129019634",
  appId: "1:131129019634:web:a996de12181fd134d0946b",
  measurementId: "G-XJELSBSYK9"
};

// Served from localhost: the viewer talks to the Firestore emulator rather
// than to the production database. Same code on both sides, throwaway
// Local database uses no quota.
// match firebase.json > emulators > firestore.
const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const EMULATOR_HOST = '127.0.0.1';
const EMULATOR_PORT = 8088;
const LOCAL_PROJECT = 'netnebula-local';

// Must match CELL_SIZE in crawler.py: it is the same grid on both sides.
const CELL_SIZE = 64;

// Must match WORLD_SPAN in crawler.py: the seeds scattered over SEED_SPREAD,
// plus the reach of a branch. Positions are brought back to a radius near 1,
// the only scale the camera knows.
const WORLD_RADIUS = 666;

// Pages in the skeleton. One Firestore read each, once.
const SKELETON = 1500;

const CACHE_KEY = 'netnebula:skeleton:v5';

// One hue per domain, drawn from its name through the golden ratio: two
// domains adjacent in the alphabet land far apart on the wheel, and the colour
// of a domain never changes as the database grows.
//
// Saturation and lightness stay restrained: at full saturation, a map of forty
// domains turns into a bag of sweets and nothing can be told apart.
const HUE_SATURATION = 0.62;
const HUE_LIGHTNESS = 0.66;

// What does not match a search dims without ever leaving the map: losing a
// landmark while searching would be exactly the defect just fixed.
// Low enough for the matches to stand out, high enough for the map around them
// to stay legible: at 0.12 the context nearly vanished, which brought back the
// very defect we were avoiding.
const DIM_FACTOR = 0.3;

// Amplitude of the breathing, in world units. Under one percent of the map
// radius: from afar it breathes, up close nothing shakes.
const SWAY = 0.006;

const REDUCED_MOTION =
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const nf = new Intl.NumberFormat('en-US');

let db = null;
let renderer = null;
let paused = false;

/** Every page loaded, by identifier. */
const loaded = new Map();

/** Cells already requested. */
const requested = new Set();
/** Display order: the index of a page in the GPU buffers. */
let order = [];
let reads = 0;

document.addEventListener('DOMContentLoaded', main);

async function main() {
  try {
    firebase.initializeApp(
      LOCAL ? { ...firebaseConfig, projectId: LOCAL_PROJECT } : firebaseConfig);
    db = firebase.firestore();
    if (LOCAL) {
      db.settings({ experimentalForceLongPolling: true,
                   experimentalAutoDetectLongPolling: false, merge: true });
      db.useEmulator(EMULATOR_HOST, EMULATOR_PORT);
    }

    const stats = await readStats(db);
    showOverlay({
      title: 'Opening the map',
      text: stats && stats.page_count
        ? `${nf.format(stats.page_count)} pages crawled.`
        : 'One moment.'
    });

    const skeleton = await loadSkeleton(stats);

    if (!skeleton.length) {
      // Tell "the crawler surveyed nothing" apart from "the pages exist but
      // have no position yet": the second is fixed by one command, and
      // reporting it as an empty database would send someone looking in the
      // wrong place.
      const unplaced = Boolean(stats && stats.page_count > 0);
      showOverlay({
        title: unplaced
          ? 'The map is being prepared'
          : 'Nothing to map yet',
        text: unplaced
          ? 'Pages have been crawled but not placed. Check back soon.'
          : 'Crawling has not started yet. The map will appear with the first pages.'
      });
      if (unplaced) console.warn('pages without a position: run `crawler.py --place`');
      return;
    }

    ingest(skeleton);
    start();
    mountSearch();
    mountLabels();
    reveal(stats);
    hideOverlay();
  } catch (error) {
    // The technical detail stays in the console. The page speaks to someone
    // who just wants to look at a map.
    console.error(error);
    showOverlay({
      title: 'The map could not be loaded',
      text: 'Check your connection and try again.',
      action: { label: 'Retry', onClick: () => location.reload() }
    });
  }
}

/* ----------------------------------------------------------------- data --- */

async function readStats(database) {
  try {
    const doc = await database.doc('meta/stats').get();
    return doc.exists ? doc.data() : null;
  } catch (error) {
    // The counters are a nicety, not a dependency.
    console.warn('meta/stats unreadable', error);
    return null;
  }
}

function toNode(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    url: d.url || '',
    title: d.title || d.url || doc.id,
    domain: d.domain || 'other',
    depth: d.depth === undefined ? 99 : d.depth,
    // Parent in the URL tree. This is what tells the edges that carry the
    // structure apart from those that cross it.
    parent: d.parent || null,
    // Pages in the subtree: the on-screen size of the node. Stable, it does
    // not depend on what happens to be loaded at the same moment.
    weight: d.weight || 1,
    linked_to: d.linked_to || [],
    x: d.x / WORLD_RADIUS,
    y: d.y / WORLD_RADIUS,
    z: d.z / WORLD_RADIUS
  };
}

/**
 * The skeleton: the shallowest pages, the ones carrying the overall shape.
 * Cached locally; reads are expensive.
 * when the crawler passes through.
 */
async function loadSkeleton(stats) {
  const stamp = cacheStamp(stats);
  const cached = location.hash === '#refresh' ? null : readCache(stamp);
  if (cached) return cached;

  // Sorted by tier in the URL tree, not by crawl depth: the first screen then
  // Show hierarchy roots and large directories,
  // linked instead of randomly scattered.
  // graph that does not hold together.
  const snapshot = await db.collection('pages')
    .orderBy('tier').limit(SKELETON).get();
  reads += snapshot.size;

  const list = [];
  snapshot.forEach((doc) => {
    const node = toNode(doc);
    // A page with no coordinates has not been placed by the crawler yet.
    if (Number.isFinite(node.x)) list.push(node);
  });

  writeCache(stamp, list);
  return list;
}

/**
 * Load the 27 cells around a point, in one query.
 *
 * A cell already requested is never requested twice: that is what bounds quota
 * consumption while wandering through the map.
 */
async function loadAround(target) {
  const base = [0, 1, 2].map(
    (i) => Math.floor((target[i] * WORLD_RADIUS) / CELL_SIZE));

  const keys = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const key = `${base[0] + dx}_${base[1] + dy}_${base[2] + dz}`;
        if (!requested.has(key)) keys.push(key);
      }
    }
  }
  if (!keys.length) return;
  for (const key of keys) requested.add(key);

  const snapshot = await db.collection('pages')
    .where('cell', 'in', keys).get();
  reads += snapshot.size;

  const fresh = [];
  snapshot.forEach((doc) => {
    if (loaded.has(doc.id)) return;
    const node = toNode(doc);
    if (Number.isFinite(node.x)) fresh.push(node);
  });

  if (fresh.length) ingest(fresh);
}

/**
 * Take in a batch of pages and rebuild the GPU buffers.
 *
 * Rebuilding entirely rather than appending in place: an edge only becomes
 * drawable once both its endpoints are loaded, so a region arriving makes
 * edges of regions already present drawable too. The cost is a few
 * milliseconds, paid when a region arrives and never per frame.
 */
function ingest(fresh) {
  for (const node of fresh) loaded.set(node.id, node);
  order = [...loaded.values()];
  upload();
}

/* --------------------------------------------------------------- cache --- */

function cacheStamp(stats) {
  if (!stats || !stats.updated_at) return null;
  const updated = stats.updated_at.toMillis
    ? stats.updated_at.toMillis()
    : String(stats.updated_at);
  return `${updated}:${stats.page_count || 0}`;
}

function readCache(stamp) {
  if (!stamp) return null;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    return cached.stamp === stamp ? cached.nodes : null;
  } catch (error) {
    return null;
  }
}

function writeCache(stamp, list) {
  if (!stamp) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ stamp, nodes: list }));
  } catch (error) {
    // localStorage quota exceeded, or storage disabled. This only saves
    // Firestore reads: the database will be read again on the next load, and
    // nothing breaks.
  }
}

/* --------------------------------------------------------------- colours --- */

/**
 * One hue per domain, and nothing more: the geometry no longer says which site
 * A page belongs to its referrer.
 * carries that information.
 *
 * The GPU only receives the hue, not an RGB triple. The conversion happens in
 * the shader so that links interpolate in hue: between the red of one domain
 * and the blue of another, a link passes through violet, where an RGB average
 * would give a grey.
 */
const paletteCache = new Map();

/** Stable hue of a domain, in degrees on the wheel. */
function hueOf(domain) {
  let hash = 2166136261;
  for (let i = 0; i < domain.length; i += 1) {
    hash ^= domain.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  // The golden ratio scatters the hues: without it, two similar names get
  // similar colours and the domains become indistinguishable.
  return (((hash / 4294967296) * 0.618033988749895) % 1) * 360;
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

function colorOf(domain) {
  let color = paletteCache.get(domain);
  if (!color) {
    color = hslToRgb(hueOf(domain), HUE_SATURATION, HUE_LIGHTNESS);
    paletteCache.set(domain, color);
  }
  return color;
}

function cssColor(domain) {
  const [r, g, b] = colorOf(domain);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

/* ------------------------------------------------------------ rendering --- */

function start() {
  const canvas = document.getElementById('orb');
  renderer = new Renderer(canvas, {
    ink: [0.55, 0.62, 0.78],
    hot: [0.66, 0.75, 1.0],
    background: [0.016, 0.020, 0.047]
  });
  renderer.onPick = onHover;
  upload();

  // Initial framing on what is actually loaded, not on an assumed radius.
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
  watchRegion();

  if (new URLSearchParams(location.search).has('debug')) startDebug();
}

/**
 * Build the buffers. One kind of node only: the page.
 *
 * No pyramid of aggregates. The previous attempt added five hundred vertices,
 * Masking uses two attributes per level.
 * vertex shader still processed every vertex. It cost more than it saved.
 *
 * What actually bounds the load is elsewhere: loading by region never brings
 * what is far away into memory at all. Selection happens there, before the
 * draw call, which is the only form of level of detail that saves anything.
 */
// Side of a density cell, in camera units. Roughly the thickness of a host
// cluster: fine enough to tell the core of a cluster from its edge, wide
// enough not to isolate every single page.
const CROWD_CELL = 0.012;

/**
 * Attenuation by local density.
 *
 * Additive blending has no ceiling: a hundred pages in the same place sum
 * their opacities and the heart of a cluster becomes a white disc with neither
 * colour nor structure, while an isolated page stays invisible. A global gain
 * cannot settle both. It moves the problem elsewhere.
 *
 * Every page is therefore attenuated by the square root of the number of pages
 * sharing its immediate neighbourhood. A cluster then gains in extent rather
 * than in intensity, and automatic exposure can rise high enough for the dust
 * to read without the clusters burning.
 */
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

  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  // Store domain hue and level.
  // attenuation by local density. The colour itself is computed in the shader,
  // which is what lets links interpolate in hue.
  const tones = new Float32Array(count * 2);
  const ranks = new Float32Array(count);
  const dims = new Float32Array(count);
  const phases = new Float32Array(count);
  const amps = new Float32Array(count);

  [...nodes].sort((a, b) => a.depth - b.depth)
    .forEach((node, rank) => { node.rank = rank; });

  const crowd = crowding(nodes);

  const pairs = [];
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    node.index = i;
    positions[i * 3] = node.x;
    positions[i * 3 + 1] = node.y;
    positions[i * 3 + 2] = node.z;
    tones[i * 2] = hueOf(node.domain) / 360;
    tones[i * 2 + 1] = crowd(i);
    ranks[i] = node.rank;
    dims[i] = node.dim === undefined ? 1 : node.dim;
    // Phase drawn from the identifier: every node breathes at its own rate,
    // and always the same one from one visit to the next.
    phases[i] = (hueOf(node.id) / 360) * Math.PI * 2;

    let shown = 0;
    // The structural edge: the page to its parent directory. It is the one the
    // layout makes short, and the one that has to be seen.
    if (node.parent && loaded.has(node.parent) && node.parent !== node.id) {
      pairs.push(i, node.parent);
    }
    for (const targetId of node.linked_to) {
      const target = loaded.get(targetId);
      if (!target || target === node || targetId === node.parent) continue;
      shown += 1;
      pairs.push(i, targetId);
    }
    node.out = node.linked_to.length;
    node.shown = shown;
    // Size says what the page carries: the pages of its subtree, plus its
    // Subtree size stabilizes visible links.
    // five hundred pages is a junction, even when none of its children are
    // loaded.
    //
    // A square root flattened the gap: a junction with fifty links was barely
    // three times the size of a leaf and nothing stood out. A plain logarithm
    // instead, bounded so the fill stays under control.
    const carries = Math.max(node.weight, 1 + shown);
    sizes[i] = 1.1 + Math.min(9.5, Math.pow(Math.log2(1 + carries), 1.7) * 0.5);
    // A heavily linked junction is anchored, an isolated page floats at the
    // end of its branch: that is what gives the motion of a tree.
    amps[i] = SWAY / (1 + Math.sqrt(shown) * 0.55);
  }

  const edges = [];
  for (let k = 0; k < pairs.length; k += 2) {
    const target = loaded.get(pairs[k + 1]);
    if (target) edges.push(pairs[k], target.index);
  }

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
    // Each endpoint carries the colour of its node: the rasteriser
    // interpolates between the two, for free. A link crossing two domains
    // changes hue along its length and shows up.
    // Hue is cyclic: between 0.95 and 0.05 direct interpolation would take the
    // long way round through green. One endpoint is shifted by a full turn so
    // the rasteriser takes the short path; `fract()` in the fragment shader
    // brings the result back into range.
    const ha = tones[a * 2];
    let hb = tones[b * 2];
    if (hb - ha > 0.5) hb -= 1;
    else if (ha - hb > 0.5) hb += 1;
    edgeTones[e * 4] = ha;
    edgeTones[e * 4 + 1] = tones[a * 2 + 1];
    edgeTones[e * 4 + 2] = hb;
    edgeTones[e * 4 + 3] = tones[b * 2 + 1];

    // Three things make an edge worth seeing: it carries the URL tree, it
    // joins two domains, it touches a junction. An edge that is none of those
    // stays in the background.
    const A = nodes[a];
    const B = nodes[b];
    const tree = A.parent === B.id || B.parent === A.id ? 1 : 0;
    const crossing = A.domain === B.domain ? 0 : 1;
    const hub = Math.min(1, Math.log2(1 + Math.min(A.shown, B.shown)) / 5);
    const boost = Math.min(1, 0.10 + 0.50 * tree + 0.25 * crossing + 0.20 * hub);
    const dim = Math.min(dims[a], dims[b]);
    for (const o of [0, 1]) {
      edgeBoost[e * 2 + o] = boost;
      edgeDims[e * 2 + o] = dim;
    }
    // Each endpoint carries the phase of its node: the stroke stays glued to
    // both its ends while breathing.
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
  refreshCounts();
}

/**
 * Load the region the camera is in, as it moves.
 *
 * Loading happens around the eye rather than around a target: with a free
 * camera, what matters is where you are, not some point you designated. A cell
 * already requested is never requested twice, which bounds quota consumption
 * even on a long wander.
 */
function watchRegion() {
  let last = null;
  let busy = false;

  setInterval(async () => {
    if (busy || !renderer) return;

    const eye = renderer.eye;
    const key = [0, 1, 2]
      .map((i) => Math.floor((eye[i] * WORLD_RADIUS) / CELL_SIZE)).join('_');
    if (key === last) return;

    busy = true;
    last = key;
    try {
      await loadAround(eye);
    } catch (error) {
      // A region that fails to load does not invalidate the map already shown.
      console.warn('region not loaded', error);
    } finally {
      busy = false;
    }
  }, 600);
}


/* ----------------------------------------------------------------- camera --- */

function bindCamera(canvas) {
  let looking = false;
  let lastX = 0;
  let lastY = 0;
  let pinch = 0;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    looking = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    renderer.mouse.x = e.clientX - rect.left;
    renderer.mouse.y = e.clientY - rect.top;
    renderer.mouse.moved = true;
    if (!looking) return;

    // As in a game camera: moving the mouse right or down turns the gaze in
    // the same direction.
    renderer.yaw += (e.clientX - lastX) * 0.004;
    renderer.pitch += (e.clientY - lastY) * 0.004;
    // Clamping the pitch avoids going over the pole, where the scene flips all
    // at once and every bearing is lost.
    renderer.pitch = Math.max(-1.45, Math.min(1.45, renderer.pitch));
    lastX = e.clientX;
    lastY = e.clientY;
  });

  const release = (e) => {
    looking = false;
    if (e && e.pointerId !== undefined && canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('pointerleave', () => {
    renderer.mouse.x = -1;
    renderer.mouse.moved = true;
  });

  // The wheel sets the field of view; movement stays on WASD/ZQSD and the
  // arrow keys.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    renderer.setFov(renderer.fov + e.deltaY * 0.0015);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2) return;
    e.preventDefault();
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY);
    if (pinch) renderer.move((d - pinch) * 0.01 * renderer.travelScale(), 0, 0);
    pinch = d;
  }, { passive: false });

  canvas.addEventListener('touchend', () => { pinch = 0; });

  canvas.addEventListener('dblclick', () => {
    if (renderer.hovered >= 0) flyToNode(renderer.hovered);
  });

  bindFlight();
}

/**
 * Free flight from the keyboard. WASD/ZQSD and the arrow keys, plus space and
 * shift to rise and descend.
 *
 * Movement happens on every frame, not on every keystroke: holding a key gives
 * continuous motion instead of a stutter driven by key repeat.
 */
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

  // Inertia: speed builds up and falls away instead of settling then stopping
  // dead. That is what gives movement weight, rather than a teleport frame by
  // frame.
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

/** Bring the camera in front of a point, in continuous flight. */
function flyTo(point, distance = 0.45) {
  if (!renderer) return;
  const from = Float32Array.from(renderer.eye);
  const fromYaw = renderer.yaw;
  const fromPitch = renderer.pitch;

  // We aim at the point from where we already are: the camera comes closer
  // without circling around, so without disorienting.
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

  // The yaw is reached by the shortest path, otherwise the camera does a full
  // turn for a target sitting just behind the seam.
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


/* -------------------------------------------------------------- interface --- */

/** A node by its index in the buffers, across every level. */
function nodeAt(index) {
  return renderer && renderer.nodes ? renderer.nodes[index] : null;
}

function onHover(index) {
  const canvas = document.getElementById('orb');
  canvas.style.cursor = index >= 0 ? 'pointer' : 'default';

  const tip = document.getElementById('tip');
  const node = index >= 0 ? nodeAt(index) : null;
  if (!node) { tip.hidden = true; return; }

  tip.querySelector('.t-title').textContent = node.title;
  tip.querySelector('.t-url').textContent = node.url.replace(/^https?:\/\//, '');
  tip.style.left = `${renderer.mouse.x + 16}px`;
  tip.style.top = `${renderer.mouse.y + 16}px`;
  tip.hidden = false;
}

function select(index) {
  const node = nodeAt(index);
  if (!node) return;
  renderer.marked = node.rank;

  const panel = document.getElementById('detail');
  panel.querySelector('.d-title').textContent = node.title;
  panel.querySelector('.d-domain').textContent = node.domain;
  panel.querySelector('.d-out').textContent = nf.format(node.out);
  panel.querySelector('.d-in').textContent = nf.format(node.shown);

  const link = panel.querySelector('.d-link');
  // URLs come from the crawled web: an href is only set on http(s), never on a
  // `javascript:` scheme dressed up as a link.
  if (/^https?:\/\//i.test(node.url)) {
    link.href = node.url;
    link.textContent = node.url.replace(/^https?:\/\//, '');
    link.hidden = false;
  } else {
    link.removeAttribute('href');
    link.hidden = true;
  }

  panel.hidden = false;
}

function clearSelection() {
  if (renderer) renderer.marked = -1;
  document.getElementById('detail').hidden = true;
}

function reveal(stats) {
  for (const el of document.querySelectorAll('#readout, #controls, #hint')) {
    el.hidden = false;
  }
  refreshCounts();
  showSurvey(stats);
}

function refreshCounts() {
  const domains = new Set([...loaded.values()].map((n) => n.domain));
  setCount('stat-nodes', loaded.size);
  setCount('stat-links', renderer ? renderer.edges : 0);
  setCount('stat-domains', domains.size);
}

/** Counters climb towards their value, including when a region arrives. */
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

/** How much is left unexplored is data, not a flaw to hide. */
function showSurvey(stats) {
  const survey = document.getElementById('survey');
  const pending = stats && stats.frontier_pending;
  const crawled = stats && stats.page_count;
  if ((!pending && pending !== 0) || !crawled) return;

  const total = crawled + pending;
  const ratio = total > 0 ? crawled / total : 1;

  const bar = survey.querySelector('i');
  bar.style.transform = `scaleX(${ratio})`;
  if (!REDUCED_MOTION) {
    bar.animate(
      [{ transform: 'scaleX(0)' }, { transform: `scaleX(${ratio})` }],
      { duration: 1400, delay: 300, easing: 'cubic-bezier(0.16,1,0.3,1)', fill: 'backwards' });
  }

  document.getElementById('survey-note').textContent = pending > 0
    ? `${nf.format(pending)} pages still unexplored`
    : 'All discovered pages have been explored';

  survey.hidden = false;
}

/* -------------------------------------------------------------- overlay --- */

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

/* --------------------------------------------------------------- controls --- */

function bindControls() {
  const canvas = document.getElementById('orb');

  canvas.addEventListener('click', () => {
    if (renderer.hovered >= 0) select(renderer.hovered);
    else clearSelection();
  });

  document.getElementById('c-fit').onclick = fit;
  document.getElementById('c-random').onclick = focusRandom;
  document.getElementById('c-pause').onclick = togglePause;
  document.querySelector('.d-close').onclick = clearSelection;

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key.toLowerCase()) {
      case 't': fit(); break;
      case 'h': focusRandom(); break;
      case 'p': togglePause(); break;
      case 'escape': clearSelection(); break;
      default: return;
    }
    event.preventDefault();
  });
}

/** Frame the whole map again. The fallback when you have got lost. */
function fit() {
  if (!renderer) return;
  const { center, radius } = renderer.extent();
  flyTo(center, renderer.distanceFor(radius));
  clearSelection();
}

function focusRandom() {
  if (!renderer || !order.length) return;
  // Among the visible nodes: aiming at a culled one would leave the camera
  // facing the void.
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

/* ------------------------------------------------------------------ labels --- */

/**
 * One name per domain, under its cluster.
 *
 * Naming every page covered the map with long titles fighting for room and
 * hiding what they pointed at. The domain says the essential thing: where you
 * are. The title of a page stays available on hover and on click, where it is
 * asked for rather than imposed.
 *
 * This also replaces the list of domains down the side: the colour is named
 * where it sits, not in an index you have to cross-reference.
 */
const MAX_LABELS = 18;

/** Clusters per domain, anchored on their main node. Recomputed when `order` changes. */
let clusters = [];
let clustersFor = -1;

function domainClusters() {
  if (clustersFor === order.length) return clusters;

  // The name is placed on the main node of the domain, not at the centroid of
  // its pages: a scattered domain has its centroid in empty space, and the
  // label ended up pointing at blackness.
  const groups = new Map();
  for (const node of order) {
    const g = groups.get(node.domain);
    if (!g || node.weight > g.anchor.weight
        || (node.weight === g.anchor.weight && node.id < g.anchor.id)) {
      groups.set(node.domain, { name: node.domain, anchor: node });
    }
  }

  clusters = [...groups.values()].sort((a, b) => b.anchor.weight - a.anchor.weight);
  clustersFor = order.length;
  return clusters;
}

function mountLabels() {
  const layer = document.getElementById('labels');
  const pool = [];

  const project = () => {
    requestAnimationFrame(project);
    if (!renderer || !renderer.mvp || paused) return;

    const m = renderer.mvp;
    const width = layer.clientWidth;
    const height = layer.clientHeight;
    const placed = [];
    let used = 0;

    // Nearest first: when two labels want the same room, the one being looked
    // at wins.
    const near = [];
    for (const g of domainClusters()) {
      const a = g.anchor;
      const w = m[3] * a.x + m[7] * a.y + m[11] * a.z + m[15];
      if (w <= 0.05) continue;
      near.push({ g, w });
    }
    near.sort((a, b) => a.w - b.w);

    for (const { g, w } of near) {
      if (used >= MAX_LABELS) break;
      const a = g.anchor;
      const sx = (m[0] * a.x + m[4] * a.y + m[8] * a.z + m[12]) / w;
      const sy = (m[1] * a.x + m[5] * a.y + m[9] * a.z + m[13]) / w;
      if (Math.abs(sx) > 1 || Math.abs(sy) > 1) continue;

      const px = (sx * 0.5 + 0.5) * width;
      const py = (0.5 - sy * 0.5) * height + 14;

      // Footprint estimated rather than measured: reading the real width would
      // force a layout reflow per label per frame.
      const half = g.name.length * 4.2 + 8;
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
      el.textContent = g.name;
      el.style.color = cssColor(g.name);
      el.style.transform = `translate(${Math.round(px)}px, ${Math.round(py)}px)`;
      el.style.opacity = '1';
      used += 1;
    }

    for (let i = used; i < pool.length; i++) pool[i].style.opacity = '0';
  };

  requestAnimationFrame(project);
}

/* ------------------------------------------------------------------ search --- */

/**
 * Matches brighten; others dim.
 * map, otherwise searching would cost you your bearings.
 */
function mountSearch() {
  const input = document.getElementById('search');
  const status = document.getElementById('search-count');
  let matches = [];

  // Titles may contain accents: searching "eugenie" should find matches.
  // Without folding accents, users must reproduce an unknown spelling.
  // reproduce a spelling you do not know yet.
  const fold = (text) => text
    .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

  const apply = () => {
    const query = fold(input.value.trim());
    matches = [];

    for (const node of order) {
      if (node.search === undefined) {
        node.search = fold(`${node.title} ${node.url} ${node.domain}`);
      }
      const hit = !query || node.search.includes(query);
      node.dim = query && !hit ? DIM_FACTOR : 1;
      if (query && hit) matches.push(node);
    }

    status.textContent = query
      ? `${nf.format(matches.length)} ${matches.length !== 1 ? 'results' : 'result'}`
      : '';
    upload();
  };

  let timer = 0;
  input.oninput = () => {
    clearTimeout(timer);
    // Typing must not rebuild the buffers on every keystroke.
    timer = setTimeout(apply, 180);
  };

  input.onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    clearTimeout(timer);
    apply();
    if (matches.length) flyToNode(matches[0].index);
  };
}

/** Diagnostic readout, on `?debug` only. */
function startDebug() {
  const el = document.createElement('p');
  el.id = 'debug';
  document.body.appendChild(el);
  setInterval(() => {
    el.textContent =
      `${renderer.fps} fps · quality ${renderer.quality}/2`
      + ` · ${nf.format(renderer.count)} nodes`
      + ` · ${nf.format(renderer.edges)} links`
      + ` · ${renderer.drawCalls} draw calls`
      + ` · ${requested.size} regions · ${nf.format(reads)} reads`;
  }, 500);
}
