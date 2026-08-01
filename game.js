'use strict';
// SILQ — Copyright © 2026 Melvin Carvalho — AGPL-3.0-or-later (see LICENSE)
// A tribute to Sil-Q. No assets: every pixel and sound generated from code.
// ?shot=<name>[&f=N] renders deterministic frames for the critic harness.
// ?autoplay=<careful|reckless>&seed=N&budget=T runs the heist bot headlessly
// (document.title carries the AUTOPLAY:{json} report).

const W = 1280, H = 720;
const TS = 40;                       // render tile size — camera crops the map, never letterboxes it
const MW = 51, MH = 24;
const HUD_H = 50, LOG_H = 94;
const VH = H - HUD_H - LOG_H;

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const DPR = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = W * DPR; canvas.height = H * DPR;
ctx.scale(DPR, DPR);

window.onerror = (msg, src, line) => { document.title = `ERR:${msg} @${line}`; };

const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot');
const AUTOPLAY = Q.get('autoplay');
const HEADLESS = !!(SHOT || AUTOPLAY);

// ---------- seeded RNG ----------
let _seed = 1;
function srand(s) { _seed = (s >>> 0) || 1; }
function rnd() { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 4294967296; }
function ri(n) { return (rnd() * n) | 0; }
function d10() { return 1 + ri(10); }
function dice(n, s) { let t = 0; const r = []; for (let i = 0; i < n; i++) { const v = 1 + ri(s); t += v; r.push(v); } return { t, r }; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
const MONO = '"Courier New", monospace';

// ---------- audio ----------
let AUDIO_ON = !HEADLESS, actx = null, master = null;
function audio() {
  if (!AUDIO_ON) return null;
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AUDIO_ON = false; return null; }
    const comp = actx.createDynamicsCompressor();
    master = actx.createGain(); master.gain.value = 0.35;
    master.connect(comp); comp.connect(actx.destination);
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function tone(f, dur, type = 'square', vol = 0.14, slideTo = 0, delay = 0) {
  const a = audio(); if (!a) return;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
  g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.02);
}
function noiseHit(vol = 0.2, dur = 0.09) {
  const a = audio(); if (!a) return;
  const n = a.sampleRate * dur | 0, buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const s = a.createBufferSource(), g = a.createGain(); s.buffer = buf;
  g.gain.value = vol; s.connect(g); g.connect(master); s.start();
}
const SFX = {
  step() { tone(110, 0.03, 'triangle', 0.03); },
  hit() { noiseHit(0.18, 0.08); tone(140, 0.08, 'square', 0.1, 70); },
  crit() { noiseHit(0.26, 0.14); tone(200, 0.14, 'sawtooth', 0.14, 60); },
  miss() { tone(300, 0.05, 'sine', 0.05, 240); },
  pick() { tone(660, 0.07, 'square', 0.08); tone(990, 0.09, 'square', 0.08, 0, 0.06); },
  quaff() { tone(440, 0.12, 'sine', 0.1, 880); },
  stairs() { tone(220, 0.4, 'sine', 0.12, 55); },
  levelup() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.1, 'square', 0.09, 0, i * 0.07)); },
  alarm() { for (let i = 0; i < 3; i++) { tone(880, 0.18, 'sawtooth', 0.12, 440, i * 0.24); } },
  wake() { tone(180, 0.12, 'sawtooth', 0.08, 320); },
  die() { tone(220, 0.7, 'sawtooth', 0.16, 40); noiseHit(0.2, 0.4); },
  win() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.22, 'triangle', 0.12, 0, i * 0.12)); },
  bolt() { tone(1200, 0.1, 'sawtooth', 0.1, 200); },
  flash() { noiseHit(0.3, 0.3); tone(1500, 0.25, 'sine', 0.12, 3000); },
};

// ---------- tiles ----------
const T_WALL = 0, T_FLOOR = 1, T_DOOR = 2, T_DOOR_OPEN = 3, T_DOWN = 4, T_UP = 5, T_DAIS = 6;
const WALKABLE = t => t !== T_WALL;
const OPAQUE = t => t === T_WALL || t === T_DOOR;

// per-depth accent hue: cyan shallow → red deep → gold vault
const DEPTH_HUE = [190, 190, 210, 250, 280, 310, 335, 355, 45];
const FT = d => d * 50;

// ---------- monsters ----------
// tier: earliest depth. speed: energy/turn (100 = player). per: perception, st: stealth of the monster itself when sneaking? (unused), see Sil for lineage.
const MDEF = {
  drone:   { name: 'DRONE',      hp: 5,  melee: 2, ev: 2, per: 3, spd: 100, dmg: [1, 4], prot: [0, 0], tier: 1, xp: 10, color: '#39d7ff', sleeps: false, glyph: 'tri' },
  sentinel:{ name: 'SENTINEL',   hp: 10, melee: 3, ev: 0, per: 4, spd: 100, dmg: [1, 6], prot: [1, 4], tier: 2, xp: 15, color: '#ffb03a', sleeps: false, glyph: 'hex', turret: true },
  hound:   { name: 'HOUND',      hp: 7,  melee: 4, ev: 4, per: 5, spd: 140, dmg: [2, 3], prot: [0, 0], tier: 2, xp: 15, color: '#f4e04a', sleeps: true,  glyph: 'chev' },
  spinner: { name: 'WEBSPINNER', hp: 9,  melee: 3, ev: 3, per: 3, spd: 90,  dmg: [1, 4], prot: [1, 3], tier: 3, xp: 15, color: '#5dff8a', sleeps: true,  glyph: 'x', webs: true },
  wraith:  { name: 'WRAITH',     hp: 7,  melee: 4, ev: 5, per: 4, spd: 70,  dmg: [1, 7], prot: [0, 0], tier: 4, xp: 25, color: '#bfe8ff', sleeps: false, glyph: 'arc', phase: true },
  warden:  { name: 'WARDEN',     hp: 17, melee: 5, ev: 1, per: 3, spd: 90,  dmg: [2, 6], prot: [1, 4], tier: 5, xp: 40, color: '#ff5ad0', sleeps: true,  glyph: 'sq' },
  hunter:  { name: 'HUNTER',     hp: 9,  melee: 5, ev: 4, per: 6, spd: 120, dmg: [2, 4], prot: [1, 3], tier: 9, xp: 20, color: '#ff4a4a', sleeps: false, glyph: 'dart' },
};

// ---------- items ----------
const WEAPONS = [
  { name: 'SHIV',     dmg: [1, 5], att: 1,  stealth: 1,  tier: 0 },
  { name: 'BATON',    dmg: [2, 4], att: 0,  stealth: 0,  tier: 2 },
  { name: 'EDGE',     dmg: [2, 6], att: 0,  stealth: 0,  tier: 4 },
  { name: 'ARC PIKE', dmg: [2, 7], att: -1, stealth: -1, tier: 6 },
];
const ARMORS = [
  { name: 'SUIT',  prot: [0, 0], stealth: 0,  tier: 0 },
  { name: 'MESH',  prot: [1, 4], stealth: 0,  tier: 1 },
  { name: 'WEAVE', prot: [2, 4], stealth: -1, tier: 3 },
  { name: 'AEGIS', prot: [2, 5], stealth: -2, tier: 5 },
];
const POTIONS = ['MEND', 'VEIL', 'FLASH'];
const POTION_COLOR = ['#ff7a9e', '#c86bff', '#f5f8ff'];

const SKILLS = ['MELEE', 'EVASION', 'STEALTH', 'GRIT'];
const SKILL_COLOR = ['#ff8a5a', '#5ad7ff', '#c86bff', '#5dff8a'];
function skillCost(cur) { return 50 * (cur + 1); }

// ---------- state ----------
let G = null;                        // whole game state
let anim = { t: 0, floats: [], parts: [], shake: 0, beams: [], rings: [], flashT: 0, flashX: 0, flashY: 0, grabT: 0, deathT: 0, winT: 0, alarmT: 0, frag: null };
let scene = 'title';                 // title | play | dead | won
let overlay = null;                  // 'skills' | 'help'
let lastMath = null;                 // last combat breakdown (for evidence strips + HUD)
let muted = false;

function newGame(seed) {
  srand(seed);
  anim.floats.length = 0; anim.parts.length = 0; anim.beams.length = 0; anim.rings.length = 0;
  anim.frag = null; anim.flashT = 0; anim.grabT = 0; anim.shake = 0;
  G = {
    seed, depth: 0, phase: 'descent', turn: 0,
    p: {
      x: 0, y: 0, hp: 22, hpMax: 22,
      skills: { MELEE: 2, EVASION: 2, STEALTH: 1, GRIT: 0 },
      xp: 60, xpTotal: 60, spent: [],
      weapon: 0, armor: 0, potions: [2, 0, 0],
      lamp: 2, power: 900, powerMax: 1200,
      shard: false, veil: 0, haste: 0, webbed: 0, moved: false,
      kills: 0, sights: {}, deaths: null,
    },
    map: null, explored: null, visible: null, mons: [], items: [],
    log: [], noiseQ: [], pulseIn: 0, gazeIn: 0,
    stats: { timesSpotted: 0, fights: 0, floorsTurns: [] },
  };
  descend();
}

function pXY() { return G.p.x + G.p.y * MW; }
function at(x, y) { return G.map[x + y * MW]; }
function setT(x, y, t) { G.map[x + y * MW] = t; }
function inMap(x, y) { return x >= 0 && y >= 0 && x < MW && y < MH; }

// ---------- mapgen ----------
function genFloor(depth, ascent) {
  const map = new Uint8Array(MW * MH); // walls
  const rooms = [];
  const isVault = depth === 8 && !ascent;
  const nRooms = isVault ? 7 : 9 + ri(4);
  for (let tries = 0; tries < 220 && rooms.length < nRooms; tries++) {
    const w = 5 + ri(8), h = 4 + ri(5);
    const x = 1 + ri(MW - w - 2), y = 1 + ri(MH - h - 2);
    if (rooms.some(r => x < r.x + r.w + 1 && x + w + 1 > r.x && y < r.y + r.h + 1 && y + h + 1 > r.y)) continue;
    rooms.push({ x, y, w, h });
  }
  let vaultRoom = null;
  if (isVault) {
    vaultRoom = { x: (MW >> 1) - 8, y: (MH >> 1) - 5, w: 16, h: 10 };
    rooms.unshift(vaultRoom);
  }
  for (const r of rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) map[x + y * MW] = T_FLOOR;
  // corridors: chain + a few loops
  const cx = r => r.x + (r.w >> 1), cy = r => r.y + (r.h >> 1);
  const link = (a, b) => {
    let x = cx(a), y = cy(a);
    const tx = cx(b), ty = cy(b);
    const carve = (x, y) => { if (map[x + y * MW] === T_WALL) map[x + y * MW] = T_FLOOR; };
    if (ri(2)) { while (x !== tx) { x += Math.sign(tx - x); carve(x, y); } while (y !== ty) { y += Math.sign(ty - y); carve(x, y); } }
    else { while (y !== ty) { y += Math.sign(ty - y); carve(x, y); } while (x !== tx) { x += Math.sign(tx - x); carve(x, y); } }
  };
  for (let i = 1; i < rooms.length; i++) link(rooms[i - 1], rooms[i]);
  for (let i = 0; i < 3; i++) link(rooms[ri(rooms.length)], rooms[ri(rooms.length)]);
  // doors: corridor tiles adjacent to room edge, narrow gap
  for (const r of rooms) {
    for (let x = r.x; x < r.x + r.w; x++) for (const y of [r.y - 1, r.y + r.h]) {
      if (inMap(x, y) && map[x + y * MW] === T_FLOOR && map[x - 1 + y * MW] === T_WALL && map[x + 1 + y * MW] === T_WALL && ri(3) === 0) map[x + y * MW] = T_DOOR;
    }
    for (let y = r.y; y < r.y + r.h; y++) for (const x of [r.x - 1, r.x + r.w]) {
      if (inMap(x, y) && map[x + y * MW] === T_FLOOR && map[x + (y - 1) * MW] === T_WALL && map[x + (y + 1) * MW] === T_WALL && ri(3) === 0) map[x + y * MW] = T_DOOR;
    }
  }
  return { map, rooms, vaultRoom };
}

function tileAtDist(map, fx, fy, lo, hi, exclude) {
  // BFS from (fx,fy); first walkable tile with distance in [lo,hi] outside `exclude` room, else farthest
  const dd = new Int16Array(MW * MH).fill(-1);
  const q = [fx + fy * MW]; dd[q[0]] = 0;
  let pick = -1, far = q[0];
  while (q.length) {
    const c = q.shift(); const x = c % MW, y = (c / MW) | 0;
    for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + ax, ny = y + ay;
      if (!inMap(nx, ny)) continue;
      const n = nx + ny * MW;
      if (dd[n] < 0 && WALKABLE(map[n])) {
        dd[n] = dd[c] + 1; far = n; q.push(n);
        const inEx = exclude && nx >= exclude.x && nx < exclude.x + exclude.w && ny >= exclude.y && ny < exclude.y + exclude.h;
        if (!inEx && dd[n] >= lo && dd[n] <= hi && pick < 0) pick = n;
      }
    }
  }
  return pick >= 0 ? pick : far;
}

function farthestFloorTile(map, fx, fy) {
  // BFS distances from (fx,fy); return farthest walkable tile
  const dist = new Int16Array(MW * MH).fill(-1);
  const q = [fx + fy * MW]; dist[q[0]] = 0;
  let best = q[0];
  while (q.length) {
    const c = q.shift(); const x = c % MW, y = (c / MW) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inMap(nx, ny)) continue;
      const n = nx + ny * MW;
      if (dist[n] < 0 && WALKABLE(map[n])) { dist[n] = dist[c] + 1; if (dist[n] > dist[best]) best = n; q.push(n); }
    }
  }
  return best;
}

function placeMonsters(depth, rooms, vaultRoom, ascent) {
  const mons = [];
  const pool = Object.keys(MDEF).filter(k => {
    const m = MDEF[k];
    return m.tier <= depth && m.tier >= Math.max(1, depth - 4) && k !== 'hunter';
  });
  const n = ascent ? 2 + ri(2) : Math.min(10, 3 + (depth >> 1) + ri(2));
  const px = G.p.x, py = G.p.y;
  for (let i = 0; i < n && pool.length; i++) {
    const r = rooms[ri(rooms.length)];
    if (vaultRoom && r === vaultRoom) continue;
    const x = r.x + ri(r.w), y = r.y + ri(r.h);
    if (!WALKABLE(at(x, y)) || (Math.abs(x - px) + Math.abs(y - py)) < 9) continue;
    if (mons.some(m => m.x === x && m.y === y)) continue;
    const kind = pool[ri(pool.length)];
    mons.push(makeMon(kind, x, y, ascent));
    if (kind === 'hound' && ri(2)) {  // hounds sleep in pairs
      const hx = clamp(x + ri(3) - 1, r.x, r.x + r.w - 1), hy = clamp(y + ri(3) - 1, r.y, r.y + r.h - 1);
      if (WALKABLE(at(hx, hy)) && !mons.some(m => m.x === hx && m.y === hy)) mons.push(makeMon('hound', hx, hy, ascent));
    }
  }
  if (vaultRoom) {
    // wardens flank the dais
    const dx = vaultRoom.x + (vaultRoom.w >> 1), dy = vaultRoom.y + (vaultRoom.h >> 1);
    mons.push(makeMon('warden', dx - 4, dy + 2, false));
    mons.push(makeMon('warden', dx + 4, dy + 2, false));
  }
  return mons;
}
function makeMon(kind, x, y, awake) {
  const d = MDEF[kind];
  return {
    kind, x, y, hp: d.hp, energy: ri(100),
    asleep: d.sleeps && !awake, state: awake ? 'wary' : 'unaware',
    tx: -1, ty: -1, loseT: 0, stun: 0, dir: ri(4),
  };
}

function placeItems(depth, rooms, vaultRoom, ascent) {
  const items = [];
  const put = (kind, sub) => {
    for (let t = 0; t < 60; t++) {
      const r = rooms[1 + ri(Math.max(1, rooms.length - 1))] || rooms[0];
      const x = r.x + ri(r.w), y = r.y + ri(r.h);
      if (!WALKABLE(at(x, y)) || at(x, y) === T_DAIS) continue;
      if (items.some(i => i.x === x && i.y === y)) continue;
      items.push({ kind, sub, x, y }); return;
    }
  };
  put('cell'); put('cell');
  if (ri(2)) put('cell');
  put('potion', ri(3)); if (ri(2)) put('potion', ri(3));
  if (!ascent) {
    for (let w = 1; w < WEAPONS.length; w++) if (WEAPONS[w].tier === depth) put('weapon', w);
    for (let a = 1; a < ARMORS.length; a++) if (ARMORS[a].tier === depth) put('armor', a);
  }
  if (vaultRoom) { put('potion', 2); put('potion', 0); put('cell'); }
  return items;
}

function descend() {
  G.depth++;
  const ascent = false;
  const { map, rooms, vaultRoom } = genFloor(G.depth, ascent);
  G.map = map; G.explored = new Uint8Array(MW * MH); G.visible = new Uint8Array(MW * MH);
  // entry: player appears in first non-vault room
  const entry = rooms[vaultRoom ? 1 : 0];
  G.p.x = entry.x + (entry.w >> 1); G.p.y = entry.y + (entry.h >> 1);
  if (vaultRoom) {
    const dx = vaultRoom.x + (vaultRoom.w >> 1), dy = vaultRoom.y + (vaultRoom.h >> 1);
    setT(dx, dy - 1, T_DAIS);
    G.vorl = { x: dx, y: dy - 3 };            // 3x3 crown above the dais
    // the vault is self-lit by the throne: its geometry is known the moment you arrive
    for (let y = vaultRoom.y - 1; y <= vaultRoom.y + vaultRoom.h; y++)
      for (let x = vaultRoom.x - 1; x <= vaultRoom.x + vaultRoom.w; x++)
        if (inMap(x, y)) G.explored[x + y * MW] = 1;
    // service lift out: a real run, but a winnable one — mid-distance, outside the vault
    const lift = tileAtDist(G.map, dx, dy - 1, 16, 24, vaultRoom);
    setT(lift % MW, (lift / MW) | 0, T_UP);
  } else {
    const down = farthestFloorTile(G.map, G.p.x, G.p.y);
    setT(down % MW, (down / MW) | 0, T_DOWN);
    G.vorl = null;
  }
  G.mons = placeMonsters(G.depth, rooms, vaultRoom, false);
  G.items = placeItems(G.depth, rooms, vaultRoom, false);
  G.p.xp += 50; G.p.xpTotal += 50;
  log(`Depth ${G.depth} — ${FT(G.depth)}ft. ${G.depth === 8 ? 'The Vault. VORL sleeps.' : '+50◆ for the descent.'}`, G.depth === 8 ? '#ffd34a' : '#8be0ff');
  computeFOV();
  if (!HEADLESS) SFX.stairs();
}

function ascendFloor() {
  G.depth--;
  if (G.depth === 0) { winGame(); return; }
  const { map, rooms } = genFloor(G.depth, true);
  G.map = map; G.explored = new Uint8Array(MW * MH); G.visible = new Uint8Array(MW * MH);
  const entry = rooms[0];
  G.p.x = entry.x + (entry.w >> 1); G.p.y = entry.y + (entry.h >> 1);
  const up = tileAtDist(G.map, G.p.x, G.p.y, 20, 28, null);
  setT(up % MW, (up / MW) | 0, T_UP);
  G.vorl = null;
  // you came this way: the climb is a race, not an exploration
  for (let i = 0; i < MW * MH; i++) if (WALKABLE(map[i])) {
    G.explored[i] = 1;
    const x = i % MW, y = (i / MW) | 0;
    for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]])
      if (inMap(x + ax, y + ay)) G.explored[x + ax + (y + ay) * MW] = 1;
  }
  G.mons = placeMonsters(G.depth, rooms, null, true);
  G.items = placeItems(G.depth, rooms, null, true);
  log(`Depth ${G.depth} — climbing. The tower is awake.`, '#ff8a8a');
  computeFOV();
  if (!HEADLESS) SFX.stairs();
}

// ---------- FOV / LOS ----------
function los(x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  while (!(x === x1 && y === y1)) {
    if (!(x === x0 && y === y0) && OPAQUE(at(x, y))) return false;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return true;
}
function visRadius() { return G.p.power > 0 ? 2 + G.p.lamp * 2 : 3; }
function computeFOV() {
  G.visible.fill(0);
  const r = visRadius();
  for (let y = Math.max(0, G.p.y - r); y <= Math.min(MH - 1, G.p.y + r); y++)
    for (let x = Math.max(0, G.p.x - r); x <= Math.min(MW - 1, G.p.x + r); x++) {
      const d2 = (x - G.p.x) * (x - G.p.x) + (y - G.p.y) * (y - G.p.y);
      if (d2 > r * r) continue;
      if (los(G.p.x, G.p.y, x, y)) { G.visible[x + y * MW] = 1; G.explored[x + y * MW] = 1; }
    }
}
function dist(ax, ay, bx, by) { return Math.abs(ax - bx) + Math.abs(ay - by); }

// ---------- log & floats ----------
function log(msg, color = '#9fb4cc') {
  G.log.push({ msg, color, turn: G.turn });
  if (G.log.length > 60) G.log.shift();
}
function float(x, y, text, color, size = 15) {
  if (HEADLESS && !SHOT) return;
  let fy = y * TS;
  // stack floaters on the same tile instead of overlapping
  while (anim.floats.some(f => Math.abs(f.x - (x * TS + TS / 2)) < 18 && Math.abs(f.y - fy) < 16)) fy -= 16;
  anim.floats.push({ x: x * TS + TS / 2, y: fy, text, color, size, ttl: 1.4, vy: -26 });
}
function ring(x, y, r1, color, lw = 2.5) {
  if (HEADLESS && !SHOT) return;
  anim.rings.push({ x: x * TS + TS / 2, y: y * TS + TS / 2, r1, t: 0, color, lw });
}
function ageFx(sec) {
  // staged captures advance many turns between renders: age transient fx so evidence frames show the fresh beat, not litter
  for (const f of anim.floats) f.ttl -= sec;
  for (const p of anim.parts) p.ttl -= sec;
  for (const b of anim.beams) b.ttl -= sec;
  for (const r of anim.rings) r.t += sec * 2;
  anim.floats = anim.floats.filter(f => f.ttl > 0);
  anim.parts = anim.parts.filter(p => p.ttl > 0);
  anim.beams = anim.beams.filter(b => b.ttl > 0);
  anim.rings = anim.rings.filter(r => r.t < 1);
  if (G) for (const m of G.mons) { if (m.fxFlash) m.fxFlash = Math.max(0, m.fxFlash - sec * 2); if (m.fxLunge) m.fxLunge.t = Math.max(0, m.fxLunge.t - sec * 2); }
  if (G && G.p.fxFlash) G.p.fxFlash = Math.max(0, G.p.fxFlash - sec * 2);
  if (G && G.p.fxLunge) G.p.fxLunge.t = Math.max(0, G.p.fxLunge.t - sec * 2);
}
function burst(x, y, color, n = 10, spd = 70) {
  if (HEADLESS && !SHOT) return;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = spd * (0.4 + Math.random() * 0.8);
    anim.parts.push({ x: 0 + x * TS + TS / 2, y: 0 + y * TS + TS / 2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, ttl: 0.4 + Math.random() * 0.4, color, size: 1.5 + Math.random() * 2 });
  }
}

// ---------- noise & stealth ----------
function makeNoise(x, y, radius) { G.noiseQ.push({ x, y, radius }); }
function playerStealth() {
  const p = G.p;
  return p.skills.STEALTH + WEAPONS[p.weapon].stealth + ARMORS[p.armor].stealth + (p.veil > 0 ? 8 : 0) + (p.moved ? 0 : 3);
}
function lampSightBonus() { return G.p.power > 0 ? G.p.lamp : 0; }

function monsterPerceptionTurn(m) {
  const d = MDEF[m.kind];
  const dd = dist(m.x, m.y, G.p.x, G.p.y);
  // noise wakes / alerts
  for (const n of G.noiseQ) {
    if (dist(m.x, m.y, n.x, n.y) <= n.radius) {
      if (m.asleep) {
        const roll = d10() + d.per, def = d10() + Math.max(0, playerStealth());
        G.lastPerc = { name: d.name, via: 'NOISE', roll: roll - d.per, per: d.per, def: def - Math.max(0, playerStealth()), stealth: Math.max(0, playerStealth()), woke: roll > def, state: m.state, asleep: true };
        if (roll > def) { m.asleep = false; m.state = 'wary'; m.tx = n.x; m.ty = n.y; if (G.visible[m.x + m.y * MW]) { log(`The ${d.name} stirs.`, '#ffd34a'); if (!HEADLESS) SFX.wake(); } }
      } else if (m.state !== 'hunt') { m.state = 'wary'; m.tx = n.x; m.ty = n.y; }
    }
  }
  if (m.asleep) return;
  // sight: within (2 + lamp*2) of monster and LOS
  const sightR = 2 + lampSightBonus() * 2 + (G.phase === 'escape' ? 2 : 0);
  if (dd <= sightR && los(m.x, m.y, G.p.x, G.p.y)) {
    const roll = d10() + d.per + (dd <= 2 ? 2 : 0);
    const def = d10() + Math.max(0, playerStealth());
    if (!m.asleep) G.lastPerc = { name: d.name, via: 'SIGHT', roll: roll - d.per - (dd <= 2 ? 2 : 0), per: d.per + (dd <= 2 ? 2 : 0), def: def - Math.max(0, playerStealth()), stealth: Math.max(0, playerStealth()), woke: roll > def, state: m.state, asleep: false };
    if (roll > def && m.state !== 'hunt') {
      m.state = 'hunt'; m.tx = G.p.x; m.ty = G.p.y; m.loseT = 0;
      G.stats.timesSpotted++;
      if (G.visible[m.x + m.y * MW]) { log(`The ${d.name} sees you!`, '#ff8a5a'); if (!HEADLESS) SFX.wake(); }
      // shout: alert others nearby
      for (const o of G.mons) if (o !== m && dist(o.x, o.y, m.x, m.y) <= 3) { o.asleep = false; if (o.state === 'unaware') { o.state = 'wary'; o.tx = G.p.x; o.ty = G.p.y; } }
    } else if (m.state === 'hunt') { m.tx = G.p.x; m.ty = G.p.y; m.loseT = 0; }
  } else if (m.state === 'hunt') {
    m.loseT++;
    if (m.loseT > 9) { m.state = 'wary'; }
  }
}

// ---------- combat (the Sil core) ----------
// attack roll: 1d10 + Melee (+wpn att, +5 vs unaware) vs 1d10 + Evasion (unaware: 1d10-5)
// net > 0 hits; every full 5 of net adds one damage die (+2 dice on assassination)
// damage: weapon dice; protection: armor dice; final = max(0, dmg - prot)
function attack(attacker, defender, opts) {
  const aName = opts.aName, dName = opts.dName;
  const attRoll = d10(), evRoll = d10();
  const attScore = attRoll + opts.att;
  const evScore = evRoll + (opts.unaware ? -5 : opts.ev);
  const net = attScore - evScore;
  const math = {
    aName, dName, attRoll, attMod: opts.att, evRoll, evMod: opts.unaware ? -5 : opts.ev,
    attScore, evScore, net, hit: net > 0, unaware: !!opts.unaware,
  };
  if (net <= 0) { lastMath = math; return { hit: false, dmg: 0, math }; }
  let extra = Math.floor(net / 5);
  if (opts.unaware) extra += 2;
  const dRoll = dice(opts.dmg[0] + extra, opts.dmg[1]);
  const pRoll = opts.noProt ? { t: 0, r: [] } : dice(opts.prot[0], opts.prot[1]);
  const dmg = Math.max(0, dRoll.t - pRoll.t);
  Object.assign(math, { extra, dmgDice: [opts.dmg[0] + extra, opts.dmg[1]], dmgRolls: dRoll.r, dmgT: dRoll.t, protDice: opts.prot, protRolls: pRoll.r, protT: pRoll.t, dmg });
  lastMath = math;
  return { hit: true, dmg, crit: extra > 0, math };
}

function playerAttack(m) {
  const p = G.p, d = MDEF[m.kind], w = WEAPONS[p.weapon];
  const unaware = m.asleep || m.state === 'unaware';
  G.stats.fights++;
  const res = attack('player', m.kind, {
    aName: 'YOU', dName: d.name,
    att: p.skills.MELEE + w.att + (unaware ? 5 : 0),
    ev: d.ev, unaware, dmg: w.dmg, prot: d.prot,
  });
  makeNoise(p.x, p.y, unaware && res.dmg >= m.hp ? 3 : 9);
  if (!res.hit) {
    log(`You miss the ${d.name}. [${res.math.attRoll}+${res.math.attMod} vs ${res.math.evRoll}${res.math.evMod < 0 ? res.math.evMod : '+' + res.math.evMod}]`, '#8aa0b8');
    float(m.x, m.y, 'miss', '#7d94ad', 13);
    if (!HEADLESS) SFX.miss();
  } else {
    m.hp -= res.dmg;
    m.asleep = false; if (m.state !== 'hunt') { m.state = 'hunt'; m.tx = p.x; m.ty = p.y; }
    const tag = unaware ? ' — assassination!' : res.crit ? ` — +${res.math.extra} die!` : '';
    log(`You hit the ${d.name} for ${res.dmg}${tag} [${res.math.dmgT} dmg − ${res.math.protT} prot]`, unaware || res.crit ? '#ffd34a' : '#d7e8f7');
    float(m.x, m.y, `${res.dmg}`, unaware || res.crit ? '#ffd34a' : '#ff8a5a', unaware ? 26 : res.crit ? 22 : 17);
    burst(m.x, m.y, d.color, res.crit || unaware ? 18 : 10);
    p.fxLunge = { dx: m.x - p.x, dy: m.y - p.y, t: 1 };
    m.fxFlash = 1;
    if (res.crit || unaware) ring(m.x, m.y, 46, unaware ? '#ffd34a' : d.color);
    anim.shake = Math.min(7, anim.shake + (res.crit || unaware ? 5 : 2.5));
    if (!HEADLESS) (res.crit || unaware ? SFX.crit : SFX.hit)();
    if (m.hp <= 0) killMonster(m);
  }
}

function monsterAttack(m) {
  const p = G.p, d = MDEF[m.kind];
  const res = attack(m.kind, 'player', {
    aName: d.name, dName: 'YOU',
    att: d.melee, ev: p.skills.EVASION + (p.webbed > 0 ? -3 : 0), unaware: false,
    dmg: d.dmg, prot: ARMORS[p.armor].prot, noProt: !!d.phase,
  });
  makeNoise(m.x, m.y, 9);
  if (!res.hit) {
    log(`The ${d.name} misses you.`, '#8aa0b8');
    float(p.x, p.y, 'miss', '#7d94ad', 13);
  } else {
    p.hp -= res.dmg;
    log(`The ${d.name} hits you for ${res.dmg}.${d.phase ? ' It ignores your armor.' : ''}`, '#ff8a8a');
    float(p.x, p.y, `${res.dmg}`, '#ff5a5a', 18);
    burst(p.x, p.y, '#ff5a5a', 12);
    m.fxLunge = { dx: p.x - m.x, dy: p.y - m.y, t: 1 };
    p.fxFlash = 1;
    anim.shake = Math.min(8, anim.shake + 3);
    if (!HEADLESS) SFX.hit();
    if (d.webs && res.dmg > 0 && p.webbed <= 0) { p.webbed = 2; log('Threads of hard light bind you!', '#5dff8a'); }
    if (p.hp <= 0) die(`slain by a ${d.name}`);
  }
}

function killMonster(m) {
  const d = MDEF[m.kind];
  G.p.kills++;
  G.p.xp += d.xp; G.p.xpTotal += d.xp;
  log(`The ${d.name} is destroyed. +${d.xp}◆`, '#5dff8a');
  burst(m.x, m.y, d.color, 22, 110);
  G.mons.splice(G.mons.indexOf(m), 1);
}

function firstSight() {
  for (const m of G.mons) {
    if (G.visible[m.x + m.y * MW] && !G.p.sights[m.kind]) {
      G.p.sights[m.kind] = 1;
      const d = MDEF[m.kind];
      const xp = d.tier * 12 + 8;
      G.p.xp += xp; G.p.xpTotal += xp;
      log(`You mark the ${d.name}. +${xp}◆ insight.`, '#8be0ff');
      float(m.x, m.y, `+${xp}◆`, '#8be0ff', 13);
    }
  }
}

// ---------- player actions ----------
function tryMove(dx, dy) {
  const p = G.p;
  const nx = p.x + dx, ny = p.y + dy;
  if (!inMap(nx, ny)) return false;
  const m = G.mons.find(m => m.x === nx && m.y === ny);
  if (m) { playerAttack(m); p.moved = true; return true; }
  if (p.webbed > 0) { p.webbed--; log(p.webbed > 0 ? 'You strain against the web…' : 'You tear free.', '#5dff8a'); return true; }
  const t = at(nx, ny);
  if (t === T_WALL) return false;
  if (t === T_DOOR) { setT(nx, ny, T_DOOR_OPEN); makeNoise(nx, ny, 5); log('The door grinds open.', '#9fb4cc'); return true; }
  p.x = nx; p.y = ny; p.moved = true;
  makeNoise(nx, ny, 3);
  if (!HEADLESS && Math.random() < 0.4) SFX.step();
  pickupHere();
  return true;
}

function pickupHere() {
  const p = G.p;
  const i = G.items.findIndex(i => i.x === p.x && i.y === p.y);
  if (i < 0) return;
  const it = G.items[i];
  if (it.kind === 'cell') { p.power = Math.min(p.powerMax, p.power + 400); log('Power cell. +400⚡', '#f4e04a'); }
  else if (it.kind === 'potion') { p.potions[it.sub]++; log(`You take a vial of ${POTIONS[it.sub]}.`, POTION_COLOR[it.sub]); }
  else if (it.kind === 'weapon') {
    if (it.sub > p.weapon) { log(`You take the ${WEAPONS[it.sub].name} (${WEAPONS[it.sub].dmg.join('d')}).`, '#ffd34a'); p.weapon = it.sub; }
    else log(`You pass over a ${WEAPONS[it.sub].name}.`, '#7d94ad');
  } else if (it.kind === 'armor') {
    if (it.sub > p.armor) { log(`You don the ${ARMORS[it.sub].name} [${ARMORS[it.sub].prot.join('d')}].`, '#ffd34a'); p.armor = it.sub; }
    else log(`You pass over ${ARMORS[it.sub].name}.`, '#7d94ad');
  }
  G.items.splice(i, 1);
  burst(p.x, p.y, '#ffd34a', 8, 50);
  if (!HEADLESS) SFX.pick();
}

function quaff(i) {
  const p = G.p;
  if (p.potions[i] <= 0) { log('That vial is empty.', '#7d94ad'); return false; }
  p.potions[i]--;
  if (i === 0) { const h = dice(3, 6).t + 4; p.hp = Math.min(p.hpMax, p.hp + h); log(`MEND knits you. +${h} HP`, '#ff7a9e'); float(p.x, p.y, `+${h}`, '#5dff8a', 16); }
  if (i === 1) {
    p.veil = 30;
    for (const m of G.mons) if (m.state === 'hunt') { m.state = 'wary'; m.loseT = 0; }
    log('VEIL — you vanish. The hunters grasp at shadows.', '#c86bff');
  }
  if (i === 2) {
    log('FLASH! White fire floods the halls.', '#f5f8ff');
    anim.flashT = 0.9; anim.flashX = p.x * TS + TS / 2; anim.flashY = p.y * TS + TS / 2;
    ring(p.x, p.y, 130, '#f5f8ff', 3); ring(p.x, p.y, 220, '#f5f8ff', 1.5);
    makeNoise(p.x, p.y, 12);
    for (const m of G.mons) if (dist(m.x, m.y, p.x, p.y) <= 8 && los(p.x, p.y, m.x, m.y)) { m.stun = 6; m.asleep = false; m.state = 'wary'; m.tx = p.x; m.ty = p.y; }
    if (!HEADLESS) SFX.flash();
  }
  if (!HEADLESS && i !== 2) SFX.quaff();
  return true;
}

function grabShard() {
  const p = G.p;
  p.shard = true;
  G.phase = 'escape';
  G.pulseIn = 15; G.gazeIn = 6;
  G.p.xp += 200; G.p.xpTotal += 200;
  log('You pry the PRIME SHARD from the crown. +200◆', '#ffd34a');
  log('VORL WAKES. RUN.', '#ff4a4a');
  // the theft has physics: gold shockwaves and a rain of sparks from the crown
  ring(p.x, p.y, 90, '#ffd34a', 3.5); ring(p.x, p.y, 180, '#ffd34a', 2); ring(p.x, p.y, 280, '#ff8a3a', 1.5);
  burst(p.x, p.y, '#ffd34a', 30, 130);
  if (G.vorl) burst(G.vorl.x, G.vorl.y, '#ff6a4a', 16, 90);
  // the Shard knows the tower: the way out is revealed
  for (let i = 0; i < MW * MH; i++) if (WALKABLE(G.map[i])) {
    G.explored[i] = 1;
    const x = i % MW, y = (i / MW) | 0;
    for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]])
      if (inMap(x + ax, y + ay)) G.explored[x + ax + (y + ay) * MW] = 1;
  }
  anim.grabT = 2.2; anim.alarmT = 1;
  for (const m of G.mons) { m.asleep = false; m.state = 'hunt'; m.tx = p.x; m.ty = p.y; }
  if (!HEADLESS) { SFX.alarm(); }
}

function useStairs() {
  const t = at(G.p.x, G.p.y);
  if (t === T_DOWN && G.phase === 'descent') { G.stats.floorsTurns.push(G.turn); descend(); return true; }
  if (t === T_UP) {
    if (!G.p.shard) { log('The lift refuses: no Shard, no exit.', '#ff8a8a'); return false; }
    G.stats.floorsTurns.push(G.turn); ascendFloor(); return true;
  }
  if (t === T_DAIS && !G.p.shard) { grabShard(); return true; }
  return false;
}

function buySkill(i) {
  const p = G.p, k = SKILLS[i];
  const cost = skillCost(p.skills[k]);
  if (p.xp < cost) { log(`Not enough insight (${cost}◆ needed).`, '#7d94ad'); return false; }
  p.xp -= cost; p.skills[k]++;
  p.spent.push(k);
  if (k === 'GRIT') { p.hpMax += 6; p.hp += 6; }
  log(`${k} rises to ${p.skills[k]}.`, SKILL_COLOR[i]);
  if (!HEADLESS) SFX.levelup();
  return true;
}

// ---------- turn engine ----------
function playerTurn(action) {
  const p = G.p;
  p.moved = false;
  let acted = false;
  if (action.type === 'move') acted = tryMove(action.dx, action.dy);
  else if (action.type === 'wait') { acted = true; }
  else if (action.type === 'potion') acted = quaff(action.i);
  else if (action.type === 'stairs') acted = useStairs();
  else if (action.type === 'lamp') { p.lamp = action.lvl; log(`Lamp ${['dim', 'low', 'bright', 'blazing'][action.lvl - 1]}.`, '#f4e04a'); acted = true; }
  else if (action.type === 'skill') { buySkill(action.i); acted = false; }  // free action
  if (!acted) { G.noiseQ.length = 0; return false; }

  G.turn++;
  // clocks
  if (p.veil > 0) p.veil--;
  if (p.haste > 0) p.haste--;
  if (p.power > 0) p.power = Math.max(0, p.power - p.lamp);
  else if (G.turn % 5 === 0) { p.hp--; if (G.turn % 15 === 0) log('Your lamp is dead. The dark gnaws.', '#ff8a8a'); if (p.hp <= 0) { die('claimed by the dark'); return true; } }
  if (G.turn % 8 === 0 && p.hp < p.hpMax) p.hp++;

  // vault gaze: linger in VORL's sight after the grab and it burns you
  if (G.vorl && p.shard && dist(p.x, p.y, G.vorl.x, G.vorl.y) <= 7 && los(G.vorl.x, G.vorl.y, p.x, p.y)) {
    G.gazeIn--;
    if (G.gazeIn < 0) {
      const g = dice(2, 5).t;
      p.hp -= g;
      log(`VORL's gaze burns you for ${g}. GET OUT.`, '#ff4a4a');
      float(p.x, p.y, `${g}`, '#ff4a4a', 20);
      anim.shake = 8;
      if (p.hp <= 0) { die("burned by VORL's gaze"); return true; }
    }
  }
  // escape pulse: the shard sings, hunters spawn and converge
  if (G.phase === 'escape' && !G.vorl) {
    if (--G.pulseIn <= 0) {
      G.pulseIn = 44;
      spawnHunters();
      for (const m of G.mons) if (m.kind === 'hunter' || dist(m.x, m.y, p.x, p.y) <= 12) { m.asleep = false; if (m.state !== 'hunt') { m.state = 'wary'; m.tx = p.x; m.ty = p.y; } }
      log('The Shard sings. They hear.', '#ff8a5a');
      anim.alarmT = 1;
    }
  }
  monstersTurn();
  G.noiseQ.length = 0;
  computeFOV();
  firstSight();
  return true;
}

function spawnHunters() {
  let placed = G.mons.filter(m => m.kind === 'hunter').length >= 4 ? 2 : 0;
  for (let t = 0; t < 200 && placed < 2; t++) {
    const x = 1 + ri(MW - 2), y = 1 + ri(MH - 2);
    if (!WALKABLE(at(x, y)) || dist(x, y, G.p.x, G.p.y) < 12) continue;
    if (G.mons.some(m => m.x === x && m.y === y)) continue;
    const h = makeMon('hunter', x, y, true);
    h.state = 'hunt'; h.tx = G.p.x; h.ty = G.p.y;
    G.mons.push(h); placed++;
  }
}

function stepToward(m, tx, ty) {
  const d = MDEF[m.kind];
  // greedy step with simple obstacle fallback (BFS for hunters/hunting)
  const opts = [];
  const dx = Math.sign(tx - m.x), dy = Math.sign(ty - m.y);
  if (Math.abs(tx - m.x) >= Math.abs(ty - m.y)) { if (dx) opts.push([dx, 0]); if (dy) opts.push([0, dy]); }
  else { if (dy) opts.push([0, dy]); if (dx) opts.push([dx, 0]); }
  opts.push([ri(3) - 1, 0], [0, ri(3) - 1]);
  for (const [ox, oy] of opts) {
    if (!ox && !oy) continue;
    const nx = m.x + ox, ny = m.y + oy;
    if (!inMap(nx, ny)) continue;
    if (nx === G.p.x && ny === G.p.y) continue; // handled by attack check
    const t = at(nx, ny);
    if (!d.phase && t === T_WALL) continue;
    if (d.phase && (nx <= 0 || ny <= 0 || nx >= MW - 1 || ny >= MH - 1)) continue;
    if (t === T_DOOR && !d.phase) { setT(nx, ny, T_DOOR_OPEN); makeNoise(nx, ny, 5); return; }
    if (G.mons.some(o => o !== m && o.x === nx && o.y === ny)) continue;
    m.x = nx; m.y = ny; return;
  }
}

function monsterAct(m) {
  const d = MDEF[m.kind];
  monsterPerceptionTurn(m);
  if (m.asleep) return;
  if (m.stun > 0) { m.stun--; return; }
  const dd = dist(m.x, m.y, G.p.x, G.p.y);
  if (d.turret) {
    // sentinels never move; they charge for a turn, then fire on a lit thief
    if (dd <= 6 && los(m.x, m.y, G.p.x, G.p.y) && (lampSightBonus() >= 2 || dd <= 3) && m.state === 'hunt') {
      if (!m.charge) {
        m.charge = 1;
        anim.beams.push({ x0: m.x, y0: m.y, x1: G.p.x, y1: G.p.y, ttl: 0.4, color: d.color, charge: true });
        if (G.visible[m.x + m.y * MW]) log('The SENTINEL charges its lance.', '#ffb03a');
      } else {
        m.charge = 0;
        anim.beams.push({ x0: m.x, y0: m.y, x1: G.p.x, y1: G.p.y, ttl: 0.25, color: d.color });
        if (!HEADLESS) SFX.bolt();
        monsterAttack(m);
      }
    } else m.charge = 0;
    return;
  }
  if (m.state === 'hunt') {
    if (dd === 1) { monsterAttack(m); return; }
    stepToward(m, m.tx, m.ty);
    if (m.x === m.tx && m.y === m.ty && dd > 1) m.state = 'wary';
  } else if (m.state === 'wary') {
    if (m.tx >= 0 && (m.x !== m.tx || m.y !== m.ty)) stepToward(m, m.tx, m.ty);
    else if (ri(3) === 0) stepToward(m, m.x + ri(5) - 2, m.y + ri(5) - 2);
  } else {
    // unaware patrol drift
    if (!d.sleeps && ri(2) === 0) stepToward(m, m.x + ri(5) - 2, m.y + ri(5) - 2);
  }
}

function monstersTurn() {
  for (const m of [...G.mons]) {
    if (G.p.hp <= 0) return;
    m.energy += MDEF[m.kind].spd;
    while (m.energy >= 100) {
      m.energy -= 100;
      if (G.mons.includes(m)) monsterAct(m);
      if (G.p.hp <= 0) return;
    }
  }
}

function die(cause) {
  G.p.deaths = cause;
  G.deathTurn = G.turn;
  scene = 'dead';
  anim.deathT = 0;
  // the diamond shatters
  anim.frag = {
    x: G.p.x * TS + TS / 2, y: G.p.y * TS + TS / 2, t: 0,
    parts: [0, 1, 2, 3, 4, 5].map(i => ({ vx: Math.cos(i * 1.05 + 0.4), vy: Math.sin(i * 1.05 + 0.4) - 0.6, spin: (i % 2 ? 1 : -1) * (2 + i), len: 5 + (i % 3) * 3 })),
  };
  burst(G.p.x, G.p.y, '#7de8ff', 24, 120);
  ring(G.p.x, G.p.y, 70, '#7de8ff', 3);
  log(`You die at ${FT(G.depth)}ft — ${cause}.`, '#ff4a4a');
  if (!HEADLESS) SFX.die();
}
function winGame() {
  scene = 'won';
  anim.winT = 0;
  log('Daylight. You are out, and the Shard is yours.', '#ffd34a');
  if (!HEADLESS) SFX.win();
}

// ==================================================================
// RENDER
// ==================================================================
function depthHue() { return DEPTH_HUE[Math.min(G ? G.depth : 1, 8)]; }
function hsl(h, s, l, a = 1) { return `hsla(${h},${s}%,${l}%,${a})`; }

function drawGlyph(x, y, kind, m) {
  const d = MDEF[kind];
  let cx = x * TS + TS / 2, cy = y * TS + TS / 2;
  if (m && m.fxLunge && m.fxLunge.t > 0) { cx += m.fxLunge.dx * TS * 0.38 * m.fxLunge.t; cy += m.fxLunge.dy * TS * 0.38 * m.fxLunge.t; }
  const bob = Math.sin(anim.t * 3 + x * 1.7 + y) * (m && m.asleep ? 0.4 : 1.4);
  const r = TS * 0.36;
  ctx.save();
  ctx.translate(cx, cy + bob);
  const asleep = m && m.asleep;
  const hitF = m && m.fxFlash > 0;
  const col = hitF ? (m.fxFlash > 0.55 ? '#ffffff' : '#ff8a8a') : asleep ? hexA(d.color, 0.45) : d.color;
  ctx.shadowColor = hitF ? '#ffffff' : col; ctx.shadowBlur = hitF ? 18 : asleep ? 4 : 12;
  if (hitF && m.fxFlash > 0.55) ctx.scale(0.86, 0.86);
  ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.fillStyle = hitF ? `rgba(255,255,255,${0.25 + m.fxFlash * 0.4})` : hexA(d.color, asleep ? 0.08 : 0.18);
  ctx.beginPath();
  if (d.glyph === 'tri') { ctx.moveTo(0, -r); ctx.lineTo(r, r * 0.8); ctx.lineTo(-r, r * 0.8); ctx.closePath(); }
  else if (d.glyph === 'hex') { for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 - Math.PI / 6; ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } ctx.closePath(); }
  else if (d.glyph === 'chev') { ctx.moveTo(-r, r * 0.7); ctx.lineTo(0, -r * 0.8); ctx.lineTo(r, r * 0.7); ctx.lineTo(0, r * 0.15); ctx.closePath(); }
  else if (d.glyph === 'x') { ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); ctx.moveTo(0, -r * 0.5); ctx.lineTo(0, r * 0.5); }
  else if (d.glyph === 'arc') { ctx.arc(0, 0, r, Math.PI * 0.15, Math.PI * 0.85, true); ctx.moveTo(-r * 0.5, r * 0.5); ctx.lineTo(-r * 0.5, r * 0.9); ctx.moveTo(r * 0.5, r * 0.5); ctx.lineTo(r * 0.5, r * 0.9); }
  else if (d.glyph === 'sq') { ctx.rect(-r * 0.85, -r * 0.85, r * 1.7, r * 1.7); }
  else if (d.glyph === 'dart') { ctx.moveTo(0, -r); ctx.lineTo(r * 0.7, r); ctx.lineTo(0, r * 0.45); ctx.lineTo(-r * 0.7, r); ctx.closePath(); }
  ctx.fill(); ctx.stroke();
  // eye / core
  if (!asleep) {
    ctx.shadowBlur = 6; ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, d.glyph === 'chev' ? -2 : 0, 2, 0, Math.PI * 2); ctx.fill();
  }
  // state pips
  if (m && !asleep && m.state !== 'unaware') {
    ctx.shadowBlur = 8;
    ctx.fillStyle = m.state === 'hunt' ? '#ff4a4a' : '#ffd34a';
    ctx.font = `bold 11px ${MONO}`; ctx.textAlign = 'center';
    ctx.fillText(m.state === 'hunt' ? '!' : '?', 0, -r - 4);
  }
  if (asleep) {
    ctx.shadowBlur = 0; ctx.fillStyle = hexA('#9fb4cc', 0.7);
    ctx.font = `10px ${MONO}`; ctx.textAlign = 'center';
    ctx.fillText('z', r * 0.8, -r * 0.6 + Math.sin(anim.t * 2) * 1.5);
  }
  if (m && m.stun > 0) {
    ctx.shadowBlur = 0; ctx.fillStyle = '#f5f8ff'; ctx.font = `bold 10px ${MONO}`; ctx.textAlign = 'center';
    ctx.fillText('✶', 0, -r - 12);
  }
  ctx.restore();
}

function drawPlayer() {
  const p = G.p;
  let cx = p.x * TS + TS / 2, cy = p.y * TS + TS / 2;
  if (p.fxLunge && p.fxLunge.t > 0) { cx += p.fxLunge.dx * TS * 0.38 * p.fxLunge.t; cy += p.fxLunge.dy * TS * 0.38 * p.fxLunge.t; }
  ctx.save();
  ctx.translate(cx, cy);
  const hitF = p.fxFlash > 0;
  const col = hitF ? '#ffffff' : p.veil > 0 ? hexA('#c86bff', 0.7) : '#e8fbff';
  ctx.shadowColor = hitF ? '#ff5a5a' : p.veil > 0 ? '#c86bff' : '#7de8ff'; ctx.shadowBlur = hitF ? 20 : 14;
  ctx.strokeStyle = col; ctx.lineWidth = 2.2; ctx.fillStyle = p.veil > 0 ? 'rgba(200,107,255,0.12)' : 'rgba(125,232,255,0.16)';
  const r = TS * 0.38;
  ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(r * 0.72, 0); ctx.lineTo(0, r); ctx.lineTo(-r * 0.72, 0); ctx.closePath();
  ctx.fill(); ctx.stroke();
  // visor
  ctx.shadowBlur = 8; ctx.strokeStyle = '#7de8ff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-r * 0.34, -r * 0.22); ctx.lineTo(r * 0.34, -r * 0.22); ctx.stroke();
  if (p.shard) {
    ctx.shadowColor = '#ffd34a'; ctx.shadowBlur = 16; ctx.strokeStyle = '#ffd34a'; ctx.fillStyle = 'rgba(255,211,74,0.5)';
    ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(3.4, 7); ctx.lineTo(0, 13); ctx.lineTo(-3.4, 7); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  if (p.webbed > 0) {
    ctx.shadowBlur = 4; ctx.strokeStyle = hexA('#5dff8a', 0.8); ctx.lineWidth = 1;
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-r, -r + i * r); ctx.lineTo(r, -r * 0.6 + i * r); ctx.stroke(); }
  }
  ctx.restore();
}

function drawShardDais(x, y) {
  const cx = 0 + x * TS + TS / 2, cy = 0 + y * TS + TS / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = hexA('#ffd34a', 0.8); ctx.lineWidth = 1.6; ctx.shadowColor = '#ffd34a'; ctx.shadowBlur = 8;
  ctx.strokeRect(-9, 4, 18, 6);
  if (!G.p.shard) {
    const pl = 1 + Math.sin(anim.t * 4) * 0.15;
    ctx.scale(pl, pl);
    ctx.fillStyle = 'rgba(255,211,74,0.6)'; ctx.strokeStyle = '#ffe9a8'; ctx.shadowBlur = 22;
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(5, -1); ctx.lineTo(0, 6); ctx.lineTo(-5, -1); ctx.closePath();
    ctx.fill(); ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const a = anim.t * 1.5 + i * Math.PI / 2;
      ctx.fillStyle = hexA('#ffd34a', 0.5 + 0.3 * Math.sin(anim.t * 5 + i));
      ctx.fillRect(Math.cos(a) * 14 - 1, Math.sin(a) * 10 - 6, 2, 2);
    }
  }
  ctx.restore();
}

function drawVorl() {
  if (!G.vorl) return;
  const v = G.vorl;
  const cx = 0 + v.x * TS + TS / 2, cy = 0 + v.y * TS + TS / 2;
  const awake = G.p.shard;
  ctx.save();
  ctx.translate(cx, cy);
  const col = awake ? '#ff4a4a' : '#8a6d3a';
  ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.shadowColor = col; ctx.shadowBlur = awake ? 24 : 10;
  ctx.fillStyle = awake ? 'rgba(255,74,74,0.10)' : 'rgba(138,109,58,0.10)';
  // the crown: wide jagged silhouette, 3 tiles wide
  ctx.beginPath();
  ctx.moveTo(-34, 16);
  ctx.lineTo(-34, -4); ctx.lineTo(-24, 8); ctx.lineTo(-16, -14); ctx.lineTo(-7, 6);
  ctx.lineTo(0, -20); ctx.lineTo(7, 6); ctx.lineTo(16, -14); ctx.lineTo(24, 8); ctx.lineTo(34, -4);
  ctx.lineTo(34, 16); ctx.closePath();
  ctx.fill(); ctx.stroke();
  // eyes
  const blink = awake ? 1 : 0.15 + 0.1 * Math.sin(anim.t * 0.8);
  ctx.fillStyle = awake ? '#ff6a6a' : hexA('#ffd34a', blink);
  ctx.shadowBlur = awake ? 18 : 4;
  ctx.beginPath(); ctx.arc(-12, 4, awake ? 4 : 2.5, 0, Math.PI * 2); ctx.arc(12, 4, awake ? 4 : 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawItem(it) {
  const cx = 0 + it.x * TS + TS / 2, cy = 0 + it.y * TS + TS / 2;
  const bob = Math.sin(anim.t * 2.5 + it.x) * 1.5;
  ctx.save();
  ctx.translate(cx, cy + bob);
  if (it.kind === 'cell') {
    ctx.strokeStyle = '#f4e04a'; ctx.fillStyle = 'rgba(244,224,74,0.25)'; ctx.shadowColor = '#f4e04a'; ctx.shadowBlur = 9; ctx.lineWidth = 1.8;
    ctx.strokeRect(-4, -6, 8, 12); ctx.fillRect(-4, -6, 8, 12);
    ctx.fillStyle = '#f4e04a'; ctx.fillRect(-2, -8, 4, 2);
  } else if (it.kind === 'potion') {
    const c = POTION_COLOR[it.sub];
    ctx.strokeStyle = c; ctx.fillStyle = hexA(c, 0.3); ctx.shadowColor = c; ctx.shadowBlur = 9; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(0, 2, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-2, -3); ctx.lineTo(-2, -7); ctx.lineTo(2, -7); ctx.lineTo(2, -3); ctx.stroke();
  } else if (it.kind === 'weapon') {
    ctx.strokeStyle = '#ff8a5a'; ctx.shadowColor = '#ff8a5a'; ctx.shadowBlur = 9; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-5, 6); ctx.lineTo(5, -6); ctx.moveTo(-2, 1); ctx.lineTo(2, 5); ctx.stroke();
  } else if (it.kind === 'armor') {
    ctx.strokeStyle = '#5ad7ff'; ctx.fillStyle = 'rgba(90,215,255,0.2)'; ctx.shadowColor = '#5ad7ff'; ctx.shadowBlur = 9; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(6, -3); ctx.lineTo(5, 4); ctx.lineTo(0, 7); ctx.lineTo(-5, 4); ctx.lineTo(-6, -3); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function render(dt) {
  anim.t += dt;
  // background
  ctx.fillStyle = '#05040a';
  ctx.fillRect(0, 0, W, H);

  if (scene === 'title') { renderTitle(); return; }
  if (!G) return;

  const hue = depthHue();
  const p = G.p;

  // camera: player-centered, clamped to the map, snapped on floor change
  const camKey = G.depth + ':' + G.phase;
  const tcx = clamp(p.x * TS + TS / 2 - W / 2, 0, MW * TS - W);
  const tcy = clamp(p.y * TS + TS / 2 - VH / 2, 0, MH * TS - VH);
  if (anim.camFor !== camKey) { anim.camX = tcx; anim.camY = tcy; anim.camFor = camKey; }
  else { const k = Math.min(1, dt * 7); anim.camX += (tcx - anim.camX) * k; anim.camY += (tcy - anim.camY) * k; }

  ctx.save();
  ctx.beginPath(); ctx.rect(0, HUD_H, W, VH); ctx.clip();
  ctx.translate(-anim.camX, HUD_H - anim.camY);
  if (anim.shake > 0.2) {
    ctx.translate((Math.random() - 0.5) * anim.shake, (Math.random() - 0.5) * anim.shake);
    anim.shake *= Math.pow(0.02, dt);
  }

  // map
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const idx = x + y * MW;
    if (!G.explored[idx]) continue;
    const t = G.map[idx];
    const vis = G.visible[idx];
    const px = 0 + x * TS, py = 0 + y * TS;
    const dd = Math.hypot(x - p.x, y - p.y);
    const lightR = visRadius();
    const lum = vis ? clamp(1 - dd / (lightR + 1), 0.12, 1) : 0;
    if (t === T_WALL) {
      // draw only walls bordering explored floor
      let edge = false;
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]])
        if (inMap(x + ax, y + ay) && G.explored[x + ax + (y + ay) * MW] && G.map[x + ax + (y + ay) * MW] !== T_WALL) { edge = true; break; }
      if (!edge) continue;
      // value ladder: walls solid, clearly above floor, with a lit top edge
      ctx.fillStyle = vis ? hsl(hue, 45, 15 + lum * 13) : hsl(222, 20, 9);
      ctx.fillRect(px, py, TS, TS);
      ctx.fillStyle = vis ? hsl(hue, 85, 38 + lum * 28, 0.75 + lum * 0.25) : hsl(222, 25, 17, 0.55);
      ctx.fillRect(px, py, TS, 2.5);
      ctx.strokeStyle = vis ? hsl(hue, 80, 30 + lum * 26, 0.35 + lum * 0.3) : hsl(222, 25, 14, 0.3);
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 1, py + 1, TS - 2, TS - 2);
    } else {
      ctx.fillStyle = vis ? hsl(hue, 42, 8.5 + lum * 8.5) : hsl(225, 16, 5.5);
      ctx.fillRect(px, py, TS, TS);
      // circuit dots
      if ((x * 7 + y * 13) % 5 === 0) {
        ctx.fillStyle = vis ? hsl(hue, 70, 28 + lum * 20, 0.4) : hsl(225, 18, 11, 0.3);
        ctx.fillRect(px + TS / 2 - 1, py + TS / 2 - 1, 2, 2);
      }
      if (t === T_DOOR || t === T_DOOR_OPEN) {
        const open = t === T_DOOR_OPEN;
        ctx.strokeStyle = hsl(hue, 90, 55, vis ? 0.9 : 0.4); ctx.lineWidth = 2;
        ctx.shadowColor = hsl(hue, 90, 55); ctx.shadowBlur = vis ? 6 : 0;
        if (open) { ctx.strokeRect(px + 2, py + 2, 4, TS - 4); ctx.strokeRect(px + TS - 6, py + 2, 4, TS - 4); }
        else { for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(px + 4, py + 5 + i * 7); ctx.lineTo(px + TS - 4, py + 5 + i * 7); ctx.stroke(); } }
        ctx.shadowBlur = 0;
      }
      if (t === T_DOWN || t === T_UP) {
        const c = t === T_DOWN ? '#5dff8a' : '#ffd34a';
        ctx.strokeStyle = hexA(c, vis ? 1 : 0.4); ctx.lineWidth = 2;
        ctx.shadowColor = c; ctx.shadowBlur = vis ? 10 : 0;
        ctx.strokeRect(px + 3, py + 3, TS - 6, TS - 6);
        ctx.font = `bold 13px ${MONO}`; ctx.textAlign = 'center'; ctx.fillStyle = hexA(c, vis ? 1 : 0.4);
        ctx.fillText(t === T_DOWN ? '▼' : '▲', px + TS / 2, py + TS / 2 + 5);
        ctx.shadowBlur = 0;
      }
      if (t === T_DAIS) drawShardDais(x, y);
    }
  }

  // light halo, clipped to visible tiles so lamplight never leaks through walls
  ctx.save();
  ctx.beginPath();
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) if (G.visible[x + y * MW]) ctx.rect(x * TS, y * TS, TS, TS);
  ctx.clip();
  const lr = visRadius() * TS;
  const grad = ctx.createRadialGradient(p.x * TS + TS / 2, p.y * TS + TS / 2, lr * 0.2, p.x * TS + TS / 2, p.y * TS + TS / 2, lr);
  grad.addColorStop(0, hsl(hue, 80, 60, 0.1));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, MW * TS, MH * TS);
  ctx.restore();

  drawVorl();
  for (const it of G.items) if (G.visible[it.x + it.y * MW]) drawItem(it);
  for (const m of G.mons) if (G.visible[m.x + m.y * MW]) drawGlyph(m.x, m.y, m.kind, m);
  if (scene !== 'dead') drawPlayer();          // when dead, the shatter fragments are the corpse

  // beams: charge = thin dashed telegraph; fire = 3-layer lance
  for (const b of anim.beams) {
    const x0 = b.x0 * TS + TS / 2, y0 = b.y0 * TS + TS / 2, x1 = b.x1 * TS + TS / 2, y1 = b.y1 * TS + TS / 2;
    const a = clamp(b.ttl * 4, 0, 1);
    ctx.save();
    if (b.charge) {
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = hexA(b.color, a * 0.45); ctx.lineWidth = 2; ctx.shadowColor = b.color; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    } else {
      ctx.shadowColor = b.color; ctx.shadowBlur = 24;
      ctx.strokeStyle = hexA(b.color, a * 0.35); ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.strokeStyle = hexA(b.color, a); ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${a})`; ctx.lineWidth = 1.2; ctx.shadowBlur = 12;
      ctx.stroke();
      // impact sparks
      ctx.fillStyle = hexA(b.color, a);
      for (let i = 0; i < 5; i++) {
        const sa = i * 1.26 + b.ttl * 7;
        ctx.fillRect(x1 + Math.cos(sa) * 10 * (1 - a + 0.4) - 1.5, y1 + Math.sin(sa) * 10 * (1 - a + 0.4) - 1.5, 3, 3);
      }
    }
    ctx.restore();
    b.ttl -= dt;
  }
  anim.beams = anim.beams.filter(b => b.ttl > 0);

  // expanding impact rings
  for (const r of anim.rings) {
    r.t += dt * 2.2;
    const rr = r.r1 * Math.min(1, r.t);
    ctx.strokeStyle = hexA(r.color, clamp(1 - r.t, 0, 1));
    ctx.lineWidth = r.lw; ctx.shadowColor = r.color; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(r.x, r.y, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
  }
  anim.rings = anim.rings.filter(r => r.t < 1);

  // death shatter: the diamond breaks apart
  if (anim.frag) {
    const f = anim.frag;
    f.t += dt;
    const a = Math.max(0.25, 1 - f.t * 0.8);
    ctx.strokeStyle = hexA('#7de8ff', a); ctx.lineWidth = 2.2; ctx.shadowColor = '#7de8ff'; ctx.shadowBlur = 12;
    for (const s of f.parts) {
      const px = f.x + s.vx * Math.min(f.t, 1.1) * 46, py = f.y + s.vy * Math.min(f.t, 1.1) * 46 + 22 * Math.min(f.t, 1.1) * Math.min(f.t, 1.1);
      ctx.save(); ctx.translate(px, py); ctx.rotate(s.spin * f.t);
      ctx.beginPath(); ctx.moveTo(-s.len, 0); ctx.lineTo(s.len, 0); ctx.stroke();
      ctx.restore();
    }
    ctx.shadowBlur = 0;
  }

  // flash-bomb: a real detonation — blinding core, radial falloff, expanding rings
  if (anim.flashT > 0) {
    const fa = Math.pow(anim.flashT, 1.6);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fg = ctx.createRadialGradient(anim.flashX, anim.flashY, 0, anim.flashX, anim.flashY, 340);
    fg.addColorStop(0, `rgba(255,255,255,${fa})`);
    fg.addColorStop(0.35, `rgba(240,246,255,${fa * 0.6})`);
    fg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = fg;
    ctx.fillRect(anim.flashX - 360, anim.flashY - 360, 720, 720);
    ctx.restore();
    anim.flashT -= dt * 1.8;
  }

  // particles & floats
  for (const pt of anim.parts) {
    pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.vy += 60 * dt; pt.ttl -= dt;
    ctx.fillStyle = hexA(pt.color, clamp(pt.ttl * 2, 0, 1));
    ctx.fillRect(pt.x, pt.y, pt.size, pt.size);
  }
  anim.parts = anim.parts.filter(p => p.ttl > 0);
  for (const f of anim.floats) {
    f.y += f.vy * dt; f.ttl -= dt;
    ctx.font = `bold ${f.size}px ${MONO}`; ctx.textAlign = 'center';
    ctx.shadowColor = f.color; ctx.shadowBlur = 8;
    ctx.fillStyle = hexA(f.color, clamp(f.ttl, 0, 1));
    ctx.fillText(f.text, f.x, f.y);
    ctx.shadowBlur = 0;
  }
  anim.floats = anim.floats.filter(f => f.ttl > 0);

  ctx.restore();

  // alarm tint in escape
  if (G.phase === 'escape' && scene === 'play') {
    const a = 0.05 + 0.04 * Math.sin(anim.t * 5) + (anim.alarmT > 0 ? anim.alarmT * 0.1 : 0);
    ctx.fillStyle = `rgba(255,40,40,${a})`;
    ctx.fillRect(0, 0, W, H);
    anim.alarmT = Math.max(0, anim.alarmT - dt);
  }
  // per-frame decay of entity hit fx
  for (const m of G.mons) {
    if (m.fxFlash > 0) m.fxFlash -= dt * 3;
    if (m.fxLunge && m.fxLunge.t > 0) m.fxLunge.t -= dt * 5;
  }
  if (G.p.fxFlash > 0) G.p.fxFlash -= dt * 3;
  if (G.p.fxLunge && G.p.fxLunge.t > 0) G.p.fxLunge.t -= dt * 5;

  renderHUD();
  renderLog();

  // alert banner: scrimmed band, positioned away from the player, drawn over everything
  if (anim.grabT > 0) {
    const pScreenY = G.p.y * TS - anim.camY + HUD_H;
    const by = pScreenY > HUD_H + VH / 2 ? HUD_H + VH * 0.22 : HUD_H + VH * 0.72;
    const a = clamp(anim.grabT, 0, 1);
    const band = ctx.createLinearGradient(0, by - 58, 0, by + 58);
    band.addColorStop(0, 'rgba(0,0,0,0)');
    band.addColorStop(0.25, `rgba(2,0,4,${a * 0.8})`);
    band.addColorStop(0.75, `rgba(2,0,4,${a * 0.8})`);
    band.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, by - 58, W, 116);
    ctx.font = `bold 44px ${MONO}`; ctx.textAlign = 'center';
    ctx.shadowColor = '#ff4a4a'; ctx.shadowBlur = 30;
    ctx.fillStyle = hexA('#ff4a4a', a);
    ctx.fillText('VORL WAKES — RUN', W / 2, by + 15);
    ctx.shadowBlur = 0; anim.grabT -= dt;
  }
  if (overlay === 'skills') renderSkills();
  if (overlay === 'help') renderHelp();
  if (SHOT && (SHOT === 'combat' || SHOT === 'alert')) renderMathPanel();
  if (scene === 'dead') renderDeath(dt);
  if (scene === 'won') renderWin(dt);
}

function bar(x, y, w, h, frac, color, bg = '#141828') {
  ctx.fillStyle = bg; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color; ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
  ctx.strokeStyle = hexA(color, 0.7); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function renderHUD() {
  const p = G.p;
  ctx.fillStyle = '#080714'; ctx.fillRect(0, 0, W, HUD_H);
  ctx.strokeStyle = hsl(depthHue(), 80, 40, 0.6); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, HUD_H - 0.5); ctx.lineTo(W, HUD_H - 0.5); ctx.stroke();
  ctx.textAlign = 'left';
  const hpFrac = Math.max(0, p.hp) / p.hpMax;
  // HP — chrome sits two notches below the play space; full saturation is reserved for danger
  ctx.font = `bold 13px ${MONO}`; ctx.fillStyle = '#c25a72';
  ctx.fillText('HP', 16, 20);
  bar(42, 10, 150, 12, hpFrac, hpFrac < 0.35 ? '#ff4a4a' : '#c25a72');
  ctx.fillStyle = '#cfd9e8'; ctx.fillText(`${Math.max(0, p.hp)}/${p.hpMax}`, 200, 20);
  // Power + lamp
  ctx.fillStyle = '#a89a3c'; ctx.fillText('PWR', 16, 40);
  bar(42, 30, 150, 12, p.power / p.powerMax, p.power < 200 ? '#ff8a5a' : '#a89a3c');
  ctx.fillStyle = '#cfd9e8'; ctx.fillText(`${p.power}/${p.powerMax}`, 200, 40);
  ctx.fillStyle = '#7d94ad'; ctx.fillText('LAMP', 292, 40);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = p.power > 0 && i < p.lamp ? '#a89a3c' : '#232840';
    ctx.fillRect(338 + i * 10, 31, 7, 10);
  }
  // depth / phase
  ctx.textAlign = 'center';
  ctx.font = `bold 17px ${MONO}`;
  const phTxt = scene === 'won' ? 'SURFACE' : G.phase === 'escape' ? `ESCAPE — ${FT(G.depth)}FT TO CLIMB` : `DEPTH ${G.depth} · ${FT(G.depth)}FT`;
  ctx.shadowColor = G.phase === 'escape' ? '#ff4a4a' : hsl(depthHue(), 90, 60); ctx.shadowBlur = 10;
  ctx.fillStyle = G.phase === 'escape' ? '#ff6a6a' : '#e8fbff';
  ctx.fillText(phTxt, W / 2, 24);
  ctx.shadowBlur = 0;
  ctx.font = `11px ${MONO}`; ctx.fillStyle = '#7d94ad';
  const protTxt = ARMORS[p.armor].prot[0] ? ARMORS[p.armor].prot.join('d') : '—';
  ctx.fillText(`${WEAPONS[p.weapon].name} ${WEAPONS[p.weapon].dmg.join('d')} · ${ARMORS[p.armor].name} ${protTxt}${p.shard ? ' · ◆SHARD' : ''}${p.veil > 0 ? ` · VEIL ${p.veil}` : ''}`, W / 2, 41);
  // right: insight + potions — insight wears gold, never the player's cyan
  ctx.textAlign = 'right';
  ctx.font = `bold 14px ${MONO}`; ctx.fillStyle = '#ffd34a';
  ctx.fillText(`◆ ${p.xp}`, W - 16, 20);
  ctx.font = `11px ${MONO}`; ctx.fillStyle = '#7d94ad';
  ctx.fillText('[S]KILLS  [?]HELP', W - 16, 40);
  ctx.textAlign = 'left';
  for (let i = 0; i < 3; i++) {
    const x = W - 350 + i * 62;
    ctx.fillStyle = p.potions[i] > 0 ? POTION_COLOR[i] : '#3a4258';
    ctx.font = `bold 12px ${MONO}`;
    ctx.fillText(`[${i + 1}]${POTIONS[i]}`, x, 20);
    ctx.fillStyle = p.potions[i] > 0 ? '#cfd9e8' : '#3a4258';
    ctx.fillText(`×${p.potions[i]}`, x + 10, 34);
  }
}

function renderLog() {
  const y0 = H - LOG_H;
  ctx.fillStyle = '#070613'; ctx.fillRect(0, y0, W, LOG_H);
  ctx.strokeStyle = hsl(depthHue(), 80, 40, 0.6); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(W, y0 + 0.5); ctx.stroke();
  ctx.textAlign = 'left'; ctx.font = `13px ${MONO}`;
  const recent = G.log.slice(-4);
  const ramp = [0.35, 0.55, 0.75, 1.0].slice(4 - recent.length);
  for (let i = 0; i < recent.length; i++) {
    const l = recent[i];
    ctx.fillStyle = hexA(l.color, ramp[i]);
    ctx.fillText(l.msg, 16, y0 + 22 + i * 18);
  }
  ctx.textAlign = 'right'; ctx.fillStyle = '#3a4258'; ctx.font = `11px ${MONO}`;
  ctx.fillText(`T${G.turn} · seed ${G.seed}`, W - 12, H - 10);
}

function panel(x, y, w, h, title, color) {
  ctx.fillStyle = 'rgba(5,4,12,0.92)'; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.shadowColor = color; ctx.shadowBlur = 12;
  ctx.strokeRect(x, y, w, h);
  ctx.shadowBlur = 0;
  if (title) {
    ctx.font = `bold 16px ${MONO}`; ctx.textAlign = 'center'; ctx.fillStyle = color;
    ctx.fillText(title, x + w / 2, y + 28);
  }
}

function renderSkills() {
  const p = G.p;
  const w = 460, h = 250, x = (W - w) / 2, y = (H - h) / 2;
  panel(x, y, w, h, 'SKILLS — SPEND INSIGHT', '#8be0ff');
  ctx.font = `bold 14px ${MONO}`; ctx.textAlign = 'left';
  ctx.fillStyle = '#ffd34a';
  ctx.fillText(`◆ ${p.xp}`, x + 24, y + 52);
  const desc = ['hit harder, hit at all', 'not get hit', 'not be seen', '+6 HP each rank'];
  for (let i = 0; i < 4; i++) {
    const yy = y + 84 + i * 36;
    const k = SKILLS[i], cur = p.skills[k], cost = skillCost(cur);
    const can = p.xp >= cost;
    ctx.fillStyle = SKILL_COLOR[i];
    ctx.font = `bold 14px ${MONO}`;
    ctx.fillText(`[${i + 1}] ${k}`, x + 24, yy);
    ctx.fillStyle = '#e8fbff';
    ctx.fillText(`${cur}`, x + 190, yy);
    ctx.fillStyle = can ? '#5dff8a' : '#3a4258';
    ctx.fillText(`→ ${cur + 1}`, x + 220, yy);
    ctx.textAlign = 'right';
    ctx.fillText(`${cost}◆`, x + w - 60, yy);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#7d94ad'; ctx.font = `11px ${MONO}`;
    ctx.fillText(desc[i], x + 24, yy + 14);
  }
  ctx.font = `11px ${MONO}`; ctx.textAlign = 'center'; ctx.fillStyle = '#7d94ad';
  ctx.fillText('press 1–4 to buy · S or ESC to close', x + w / 2, y + h - 14);
}

function renderHelp() {
  const w = 560, h = 330, x = (W - w) / 2, y = (H - h) / 2;
  panel(x, y, w, h, 'SILQ — THE HEIST', '#c86bff');
  const lines = [
    ['MOVE / ATTACK', 'arrows or WASD (bump to fight)'],
    ['WAIT', 'space or .'],
    ['STAIRS / GRAB', 'enter on ▼ ▲ or the dais'],
    ['POTIONS', '1 mend · 2 veil · 3 flash'],
    ['LAMP', 'L cycles 1–4 · bright sees far, is seen far'],
    ['SKILLS', 'S spend insight ◆'],
    ['', ''],
    ['DOWN', 'eight floors to the Vault'],
    ['GRAB', 'pry the Prime Shard from the crown'],
    ['OUT', 'climb back while the tower hunts'],
  ];
  ctx.textAlign = 'left'; ctx.font = `13px ${MONO}`;
  lines.forEach((l, i) => {
    ctx.fillStyle = '#8be0ff'; ctx.fillText(l[0], x + 30, y + 62 + i * 24);
    ctx.fillStyle = '#9fb4cc'; ctx.fillText(l[1], x + 190, y + 62 + i * 24);
  });
}

function renderMathPanel() {
  if (SHOT === 'alert') { renderStealthPanel(); return; }
  if (!lastMath) return;
  const m = lastMath;
  const w = 470, h = 148, x = W - w - 14, y = HUD_H + 12;
  panel(x, y, w, h, null, '#ffd34a');
  ctx.textAlign = 'left';
  const enemyAtk = m.aName !== 'YOU';
  ctx.font = `bold 13px ${MONO}`; ctx.fillStyle = '#ffd34a';
  ctx.fillText(`COMBAT MATH — ${m.aName} → ${m.dName}${m.unaware ? ' (UNAWARE)' : ''}`, x + 14, y + 22);
  ctx.font = `13px ${MONO}`; ctx.fillStyle = '#e8fbff';
  const sgn = v => (v < 0 ? `${v}` : `+${v}`);
  ctx.fillText(`ATT 1d10[${m.attRoll}]${sgn(m.attMod)} = ${m.attScore}   vs   EVA 1d10[${m.evRoll}]${sgn(m.evMod)} = ${m.evScore}`, x + 14, y + 46);
  // color keyed to consequence for the player, not for the attacker
  ctx.fillStyle = !m.hit ? '#8aa0b8' : enemyAtk ? '#ff8a5a' : '#5dff8a';
  ctx.fillText(`net ${m.net} → ${m.hit ? 'HIT' : 'MISS'}${m.hit && m.extra ? ` (+${m.extra} damage ${m.extra === 1 ? 'die' : 'dice'})` : ''}`, x + 14, y + 68);
  if (m.hit) {
    ctx.fillStyle = '#e8fbff';
    ctx.fillText(`DMG ${m.dmgDice[0]}d${m.dmgDice[1]}[${m.dmgRolls.join(',')}] = ${m.dmgT}   −   PROT ${m.protDice[0]}d${m.protDice[1]}[${m.protRolls.join(',') || '—'}] = ${m.protT}`, x + 14, y + 90);
    ctx.font = `bold 14px ${MONO}`;
    if (m.dmg === 0) { ctx.fillStyle = '#8aa0b8'; ctx.fillText('ABSORBED — 0', x + 14, y + 112); }
    else { ctx.fillStyle = enemyAtk ? '#ff6a6a' : '#ffd34a'; ctx.fillText(`FINAL ${m.dmg}`, x + 14, y + 112); }
  }
  ctx.font = `10px ${MONO}`; ctx.fillStyle = '#6a7a90';
  ctx.fillText('EVIDENCE STRIP — dice are live engine rolls; target is an immortal dummy', x + 14, y + h - 12);
}

function renderStealthPanel() {
  const w = 470, h = 118, x = W - w - 14, y = HUD_H + 12;
  panel(x, y, w, h, null, '#c86bff');
  ctx.textAlign = 'left';
  ctx.font = `bold 13px ${MONO}`; ctx.fillStyle = '#c86bff';
  ctx.fillText('STEALTH MATH — last perception check', x + 14, y + 22);
  ctx.font = `13px ${MONO}`;
  if (!G.lastPerc) {
    ctx.fillStyle = '#9fb4cc';
    ctx.fillText('no check yet — nothing has sensed you', x + 14, y + 48);
    return;
  }
  const q = G.lastPerc;
  ctx.fillStyle = '#e8fbff';
  ctx.fillText(`${q.name} (${q.asleep ? 'ASLEEP' : q.state.toUpperCase()}) checks via ${q.via}`, x + 14, y + 46);
  ctx.fillText(`PER 1d10[${q.roll}]+${q.per} = ${q.roll + q.per}   vs   STL 1d10[${q.def}]+${q.stealth} = ${q.def + q.stealth}`, x + 14, y + 68);
  // verdict reflects the monster's actual state, not just this check
  let verdict, vcol;
  if (q.asleep) { verdict = q.woke ? 'WAKES → WARY' : 'SLEEPS ON — unheard'; vcol = q.woke ? '#ff8a5a' : '#5dff8a'; }
  else if (q.state === 'hunt') { verdict = 'ALREADY HUNTING — it knows where you are'; vcol = '#ff6a6a'; }
  else { verdict = q.woke ? 'SPOTS YOU → HUNT' : `CHECK FAILS — still ${q.state.toUpperCase()}`; vcol = q.woke ? '#ff8a5a' : '#5dff8a'; }
  ctx.fillStyle = vcol;
  ctx.font = `bold 14px ${MONO}`;
  ctx.fillText(verdict, x + 14, y + 96);
}

function renderTitle() {
  const t = anim.t;
  // arcology silhouette: descending shafts, fading in from the top, composed toward the center
  ctx.save();
  for (let i = 0; i < 12; i++) {
    const hue = DEPTH_HUE[Math.min(i, 8)];
    const y = 12 + i * 56;
    const fadeTop = clamp((y - 10) / 280, 0.15, 1);
    ctx.lineWidth = 1;
    for (let x = 60; x < W - 60; x += 24) {
      if ((x * 13 + i * 29) % 7 < 4) {
        const centerBias = 1.35 - Math.abs(x - W / 2) / (W * 0.55) - Math.abs(y - 300) / 900;
        ctx.strokeStyle = hsl(hue, 80, 40, 0.42 * fadeTop * clamp(centerBias, 0.25, 1));
        ctx.strokeRect(x, y, 18, 40);
      }
    }
  }
  // scanline sweep
  const sy = (t * 60) % H;
  ctx.fillStyle = 'rgba(139,224,255,0.05)';
  ctx.fillRect(0, sy, W, 3);
  // scrims: one smooth pool of dark behind each text group
  for (const [cy, ch] of [[240, 260], [400, 90], [500, 60], [560, 40], [640, 40]]) {
    const g = ctx.createRadialGradient(W / 2, cy, 60, W / 2, cy, ch + 320);
    g.addColorStop(0, 'rgba(3,2,8,0.78)');
    g.addColorStop(1, 'rgba(3,2,8,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, cy - ch - 80, W, (ch + 80) * 2);
  }
  ctx.restore();

  // wordmark
  ctx.textAlign = 'center';
  ctx.font = `bold 120px ${MONO}`;
  ctx.shadowColor = '#c86bff'; ctx.shadowBlur = 42;
  ctx.fillStyle = '#0c0618';
  ctx.strokeStyle = '#c86bff'; ctx.lineWidth = 3;
  ctx.strokeText('S I L Q', W / 2, 240);
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#f0dcff';
  ctx.fillText('S I L Q', W / 2, 240);
  ctx.shadowBlur = 0;

  // shard
  ctx.save();
  ctx.translate(W / 2, 320 + Math.sin(t * 2) * 4);
  ctx.shadowColor = '#ffd34a'; ctx.shadowBlur = 26;
  ctx.fillStyle = 'rgba(255,211,74,0.7)'; ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(9, -2); ctx.lineTo(0, 12); ctx.lineTo(-9, -2); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();

  ctx.font = `16px ${MONO}`; ctx.fillStyle = '#9fb4cc';
  ctx.fillText('a tribute to Sil-Q — descend · steal the Prime Shard · climb out alive', W / 2, 390);
  ctx.font = `13px ${MONO}`; ctx.fillStyle = '#7d94ad';
  ctx.fillText('turn-based · every roll on screen · stealth is a real answer', W / 2, 416);

  const blink = Math.sin(t * 4) > -0.3;
  if (blink) {
    ctx.font = `bold 20px ${MONO}`;
    ctx.shadowColor = '#8be0ff'; ctx.shadowBlur = 14;
    ctx.fillStyle = '#8be0ff';
    ctx.fillText('PRESS ENTER', W / 2, 500);
    ctx.shadowBlur = 0;
  }
  ctx.font = `12px ${MONO}`; ctx.fillStyle = '#8496ac';
  ctx.fillText('arrows/WASD move · bump to fight · L lamp · 1-3 vials · S skills · ? help', W / 2, 560);
  ctx.fillStyle = '#68788e';
  ctx.fillText('zero assets — every pixel and sound from code · AGPL', W / 2, 640);
}

function renderDeath(dt) {
  anim.deathT = Math.min(1.6, anim.deathT + dt);
  const a = clamp(anim.deathT / 1.2, 0, 0.86);
  ctx.fillStyle = `rgba(5,2,8,${a})`;
  ctx.fillRect(0, 0, W, H);
  if (anim.deathT < 0.5) return;
  ctx.textAlign = 'center';
  ctx.font = `bold 54px ${MONO}`;
  ctx.shadowColor = '#ff4a4a'; ctx.shadowBlur = 30;
  ctx.fillStyle = '#ff6a6a';
  ctx.fillText('THE TOWER KEEPS YOU', W / 2, 280);
  ctx.shadowBlur = 0;
  ctx.font = `16px ${MONO}`; ctx.fillStyle = '#e8fbff';
  ctx.fillText(`${G.p.deaths} · ${FT(G.depth)}ft · turn ${G.deathTurn ?? G.turn}${G.p.shard ? ' · the Shard sinks with you' : ''}`, W / 2, 330);
  ctx.fillStyle = '#9fb4cc'; ctx.font = `14px ${MONO}`;
  ctx.fillText(`${G.p.kills} destroyed · ${G.p.xpTotal}◆ insight earned · seed ${G.seed}`, W / 2, 358);
  ctx.font = `bold 16px ${MONO}`; ctx.fillStyle = '#8be0ff';
  ctx.fillText('ENTER — descend again', W / 2, 430);
}

function renderWin(dt) {
  anim.winT = Math.min(2, anim.winT + dt);
  const a = clamp(anim.winT / 1.2, 0, 0.9);
  ctx.fillStyle = `rgba(8,6,2,${a})`;
  ctx.fillRect(0, 0, W, H);
  // rising motes
  if (Math.random() < 0.3) anim.parts.push({ x: Math.random() * W, y: H, vx: 0, vy: -40 - Math.random() * 60, ttl: 3, color: '#ffd34a', size: 2 });
  ctx.textAlign = 'center';
  ctx.font = `bold 60px ${MONO}`;
  ctx.shadowColor = '#ffd34a'; ctx.shadowBlur = 36;
  ctx.fillStyle = '#ffe9a8';
  ctx.fillText('OUT WITH THE SHARD', W / 2, 270);
  // the object of the whole heist, held up to the light
  ctx.save();
  ctx.translate(W / 2, 470 + Math.sin(anim.t * 2) * 5);
  const pl = 1 + 0.06 * Math.sin(anim.t * 3);
  ctx.scale(pl * 2.2, pl * 2.2);
  ctx.shadowColor = '#ffd34a'; ctx.shadowBlur = 40;
  ctx.fillStyle = 'rgba(255,211,74,0.75)'; ctx.strokeStyle = '#fff3cd'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(9, -2); ctx.lineTo(0, 12); ctx.lineTo(-9, -2); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
  ctx.shadowBlur = 0;
  ctx.font = `16px ${MONO}`; ctx.fillStyle = '#e8fbff';
  ctx.fillText(`${G.turn} turns · ${G.p.kills} destroyed · ${G.stats.timesSpotted} times seen`, W / 2, 330);
  ctx.fillStyle = '#9fb4cc'; ctx.font = `14px ${MONO}`;
  const sk = SKILLS.map(k => `${k.slice(0, 2)} ${G.p.skills[k]}`).join(' · ');
  ctx.fillText(`${sk} · seed ${G.seed}`, W / 2, 358);
  ctx.font = `bold 16px ${MONO}`; ctx.fillStyle = '#8be0ff';
  ctx.fillText('ENTER — descend again', W / 2, 430);
}

// ==================================================================
// INPUT
// ==================================================================
const DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], W: [0, -1], S: [0, 1], A: [-1, 0], D: [1, 0] };
window.addEventListener('keydown', e => {
  if (HEADLESS) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  if (e.key === 'm' || e.key === 'M') { muted = !muted; AUDIO_ON = !muted; return; }
  if (scene === 'title') { if (e.key === 'Enter') { newGame(Q.get('seed') ? +Q.get('seed') : (Math.random() * 1e9) | 0); scene = 'play'; } return; }
  if (scene === 'dead' || scene === 'won') { if (e.key === 'Enter') { newGame((Math.random() * 1e9) | 0); scene = 'play'; } return; }
  if (overlay === 'skills') {
    if (e.key >= '1' && e.key <= '4') { playerTurn({ type: 'skill', i: +e.key - 1 }); return; }
    if (e.key === 's' || e.key === 'S' || e.key === 'Escape') overlay = null;
    return;
  }
  if (overlay === 'help') { overlay = null; return; }
  if (e.key === 's' || e.key === 'S') {
    // S conflicts with WASD down: use only when shift? No — use S for skills, s moves down.
    if (e.key === 'S') { overlay = 'skills'; return; }
  }
  if (e.key === '?') { overlay = 'help'; return; }
  const d = DIRS[e.key];
  if (d && !(e.key === 's')) { playerTurn({ type: 'move', dx: d[0], dy: d[1] }); return; }
  if (e.key === 's') { playerTurn({ type: 'move', dx: 0, dy: 1 }); return; }
  if (e.key === ' ' || e.key === '.') { playerTurn({ type: 'wait' }); return; }
  if (e.key === 'Enter' || e.key === '>' || e.key === '<') { playerTurn({ type: 'stairs' }); return; }
  if (e.key >= '1' && e.key <= '3') { playerTurn({ type: 'potion', i: +e.key - 1 }); return; }
  if (e.key === 'l' || e.key === 'L') { playerTurn({ type: 'lamp', lvl: (G.p.lamp % 4) + 1 }); return; }
});

// ==================================================================
// HEIST BOT
// ==================================================================
function botPath(sx, sy, goal, danger) {
  // Dijkstra-lite BFS with danger costs; goal: (x,y)=>bool. returns first step [dx,dy] or null
  const cost = new Float32Array(MW * MH).fill(1e9);
  const from = new Int32Array(MW * MH).fill(-1);
  const start = sx + sy * MW;
  cost[start] = 0;
  const open = [[0, start]];
  let goalIdx = -1;
  while (open.length) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
    const [c, cur] = open.splice(bi, 1)[0];
    if (c > cost[cur]) continue;
    const x = cur % MW, y = (cur / MW) | 0;
    if (goal(x, y)) { goalIdx = cur; break; }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inMap(nx, ny)) continue;
      const n = nx + ny * MW;
      const t = G.map[n];
      if (t === T_WALL) continue;
      // monster tiles are passable at a price: stepping onto one is an attack
      const monCost = G.mons.some(m => m.x === nx && m.y === ny) && !goal(nx, ny) ? 30 : 0;
      const step = 1 + (t === T_DOOR ? 0.5 : 0) + monCost + (danger ? danger[n] : 0);
      if (cost[cur] + step < cost[n]) { cost[n] = cost[cur] + step; from[n] = cur; open.push([cost[n], n]); }
    }
  }
  if (goalIdx < 0) return null;
  let cur = goalIdx;
  while (from[cur] !== start && from[cur] !== -1) cur = from[cur];
  if (from[cur] === -1 && cur !== goalIdx) return null;
  return [(cur % MW) - sx, ((cur / MW) | 0) - sy];
}

function botDangerMap(careful) {
  if (!careful) return null;
  const d = new Float32Array(MW * MH);
  for (const m of G.mons) {
    if (!G.explored[m.x + m.y * MW] && !G.visible[m.x + m.y * MW]) continue;
    const def = MDEF[m.kind];
    const r = m.asleep ? 2 : 4;
    const heavy = m.kind === 'wraith' || m.kind === 'warden' ? 2 : 1;
    for (let y = Math.max(0, m.y - r); y <= Math.min(MH - 1, m.y + r); y++)
      for (let x = Math.max(0, m.x - r); x <= Math.min(MW - 1, m.x + r); x++) {
        const dd = dist(x, y, m.x, m.y);
        if (dd <= r) d[x + y * MW] += heavy * (m.asleep ? 2.5 : m.state === 'hunt' ? 1 : 4) * (r + 1 - dd);
      }
    // sentinels poison every tile in their firing line
    if (def.turret && !m.asleep) {
      for (let y = Math.max(0, m.y - 6); y <= Math.min(MH - 1, m.y + 6); y++)
        for (let x = Math.max(0, m.x - 6); x <= Math.min(MW - 1, m.x + 6); x++) {
          if (dist(x, y, m.x, m.y) <= 6 && WALKABLE(G.map[x + y * MW]) && los(m.x, m.y, x, y)) d[x + y * MW] += 14;
        }
    }
  }
  return d;
}

function botDecide(mode) {
  const p = G.p;
  const careful = mode === 'careful';
  if (!G.botMem) G.botMem = { threatTurn: -99, hist: [], commit: 0 };
  const mem = G.botMem;
  // oscillation watchdog: revisiting the same tiles → commit to the objective, no second-guessing
  mem.hist.push(p.x + p.y * MW);
  if (mem.hist.length > 24) mem.hist.shift();
  if (mem.commit > 0) mem.commit--;
  else if (mem.hist.length === 24 && mem.hist.filter(h => h === mem.hist[23]).length >= 4) { mem.commit = 30; mem.hist.length = 0; }
  const committed = mem.commit > 0;
  // 0. skills: spend when affordable — melee/evasion ladder, then stealth/grit
  const s = p.skills;
  const prio = careful
    ? (s.MELEE <= s.EVASION ? ['MELEE'] : ['EVASION']).concat(s.MELEE >= 4 && s.EVASION >= 4 ? ['STEALTH', 'GRIT'] : ['GRIT'])
    : ['MELEE', 'MELEE', 'GRIT', 'EVASION'];
  for (const k of prio) {
    if (p.xp >= skillCost(p.skills[k])) return { type: 'skill', i: SKILLS.indexOf(k) };
  }
  // fleeing the vault: the only goal is the lift
  const vaultFlee = careful && p.shard && G.vorl;
  const seen = G.mons.filter(m => G.visible[m.x + m.y * MW]);
  const awake = seen.filter(m => !m.asleep);
  const hunters = awake.filter(m => m.state === 'hunt');
  if (awake.length) G.botMem.threatTurn = G.turn;
  // 1. lamp discipline with hysteresis (a lamp change costs a turn)
  const threatFresh = G.turn - G.botMem.threatTurn < 12;
  const wantLamp = careful ? (G.phase === 'escape' || threatFresh ? 1 : 2) : 4;
  if (p.lamp !== wantLamp && p.power > 0 && !G.mons.some(m => dist(m.x, m.y, p.x, p.y) === 1)) return { type: 'lamp', lvl: wantLamp };
  // 2. emergency heal
  if (p.hp < p.hpMax * 0.45 && p.potions[0] > 0) return { type: 'potion', i: 0 };
  // 3. flash when swarmed (or right after the grab); veil when fleeing with the shard
  if (careful && p.potions[2] > 0 && hunters.filter(m => dist(m.x, m.y, p.x, p.y) <= (vaultFlee ? 3 : 2)).length >= (vaultFlee ? 1 : 2)) return { type: 'potion', i: 2 };
  if (careful && G.phase === 'escape' && p.veil <= 0 && p.potions[1] > 0 && hunters.length >= 2) return { type: 'potion', i: 1 };
  // 4. adjacent threats (careful lets sleepers lie — assassination happens via pathing)
  const adjAll = G.mons.filter(m => dist(m.x, m.y, p.x, p.y) === 1 && (!careful || !m.asleep));
  const adj = adjAll[0];
  if (adj && !vaultFlee) {
    const d = MDEF[adj.kind];
    const weak = adj.hp <= 6 || adj.asleep || adj.stun > 0;
    const fast = d.spd > 100;      // never flee what you cannot outrun
    const badTrade = careful && !committed && !weak && (adj.kind === 'wraith' || (adj.kind === 'warden' && p.hp < p.hpMax * 0.7));
    if (badTrade && p.webbed <= 0) {
      const away = botPath(p.x, p.y, (x, y) => dist(x, y, adj.x, adj.y) >= 5, botDangerMap(true));
      if (away) return { type: 'move', dx: away[0], dy: away[1] };
    }
    if (!careful || weak || fast || p.webbed > 0 || p.hp > p.hpMax * 0.45 || p.potions[0] === 0) {
      // hit the weakest adjacent target
      const target = adjAll.slice().sort((a, b) => a.hp - b.hp)[0];
      return { type: 'move', dx: target.x - p.x, dy: target.y - p.y };
    }
    const away = botPath(p.x, p.y, (x, y) => dist(x, y, adj.x, adj.y) >= 4, botDangerMap(true));
    if (away) return { type: 'move', dx: away[0], dy: away[1] };
    return { type: 'move', dx: adj.x - p.x, dy: adj.y - p.y };
  }
  // 5. reckless picks fights it can see
  if (!careful && seen.length) {
    const t = seen[0];
    const step = botPath(p.x, p.y, (x, y) => dist(x, y, t.x, t.y) <= 1, null);
    if (step) return { type: 'move', dx: step[0], dy: step[1] };
  }
  const danger = botDangerMap(careful);
  // 6. stand on goal tiles
  const here = at(p.x, p.y);
  if ((here === T_DOWN && G.phase === 'descent') || (here === T_UP && p.shard) || (here === T_DAIS && !p.shard)) return { type: 'stairs' };
  // 7. objective pathing
  const wantTile = t => {
    if (G.depth === 8 && !p.shard) return t === T_DAIS;
    if (p.shard || G.phase === 'escape') return t === T_UP;
    return t === T_DOWN;
  };
  // starving during the climb: grab a nearby cell even while hunted
  if (careful && p.power < 500 && !vaultFlee) {
    const cell = G.items
      .filter(it => it.kind === 'cell' && (G.explored[it.x + it.y * MW] || G.visible[it.x + it.y * MW]) && dist(it.x, it.y, p.x, p.y) <= 12)
      .sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y))[0];
    if (cell) {
      const step = botPath(p.x, p.y, (x, y) => x === cell.x && y === cell.y, danger);
      if (step) return { type: 'move', dx: step[0], dy: step[1] };
    }
  }
  // pick up worthwhile items nearby first (careful only; skip while threatened, starving, or fleeing)
  if (careful && hunters.length === 0 && p.power > 250 && !vaultFlee) {
    const near = G.items
      .filter(it => (G.explored[it.x + it.y * MW] || G.visible[it.x + it.y * MW]) && (dist(it.x, it.y, p.x, p.y) <= 12 || it.kind === 'cell'))
      .sort((a, b) => dist(a.x, a.y, p.x, p.y) - dist(b.x, b.y, p.x, p.y))[0];
    if (near) {
      const step = botPath(p.x, p.y, (x, y) => x === near.x && y === near.y, danger);
      if (step) return { type: 'move', dx: step[0], dy: step[1] };
    }
  }
  let step = null;
  // known goal?
  let goalKnown = false;
  for (let i = 0; i < MW * MH; i++) if (G.explored[i] && wantTile(G.map[i])) { goalKnown = true; break; }
  // starving or oscillating: beeline for the goal, danger be damned
  const desperate = p.power < 150 || vaultFlee || committed;
  if (goalKnown) step = botPath(p.x, p.y, (x, y) => wantTile(at(x, y)), desperate ? null : danger);
  if (!step) {
    // explore: nearest unexplored frontier
    step = botPath(p.x, p.y, (x, y) => {
      if (G.explored[x + y * MW]) return false;
      return true;
    }, danger);
  }
  if (!step) {
    // desperate: ignore danger & monsters blocking
    step = botPath(p.x, p.y, (x, y) => (goalKnown ? wantTile(at(x, y)) : !G.explored[x + y * MW]), null);
  }
  if (step) return { type: 'move', dx: step[0], dy: step[1] };
  return { type: 'wait' };
}

function runAutoplay() {
  const mode = AUTOPLAY === 'reckless' ? 'reckless' : 'careful';
  const seed = +(Q.get('seed') || 1);
  const budget = +(Q.get('budget') || 6000);
  newGame(seed);
  scene = 'play';
  let stuck = 0, lastProgress = 0;
  const progress = () => G.depth * 1000 + (G.p.shard ? 500 : 0) + G.turn * 0.001 + (G.phase === 'escape' ? (9 - G.depth) * 1000 : 0);
  let guard = 0;
  while (scene === 'play' && G.turn < budget && guard < budget * 3) {
    guard++;
    const act = botDecide(mode);
    const before = G.turn;
    playerTurn(act);
    if (act.type === 'skill') continue;
    if (G.turn === before) { stuck++; if (stuck > 40) { playerTurn({ type: 'wait' }); stuck = 0; } }
    const pr = progress();
    if (pr > lastProgress + 0.5) { lastProgress = pr; stuck = 0; }
  }
  const p = G.p;
  const report = {
    mode, seed, result: scene === 'won' ? 'WIN' : scene === 'dead' ? 'DEATH' : (G.turn >= budget ? 'TIMEOUT' : 'STUCK'),
    depth: G.depth, ft: FT(G.depth), shard: p.shard, phase: G.phase,
    turns: G.turn, kills: p.kills, spotted: G.stats.timesSpotted,
    hp: Math.max(0, p.hp), hpMax: p.hpMax, power: p.power,
    cause: p.deaths || null,
    skills: { ...p.skills }, xpTotal: p.xpTotal,
  };
  document.title = 'AUTOPLAY:' + JSON.stringify(report);
  const pre = document.createElement('pre');
  pre.id = 'telemetry';
  pre.textContent = 'AUTOPLAY:' + JSON.stringify(report);
  document.body.appendChild(pre);
  render(0.016);
}

// ==================================================================
// SHOT STAGING — deterministic frames for the critic harness
// ==================================================================
function stageWalk(moves) {
  for (const [dx, dy] of moves) { playerTurn(dx === 0 && dy === 0 ? { type: 'wait' } : { type: 'move', dx, dy }); ageFx(0.45); }
}
function stageArena(seed) {
  // tiny fixed room for evidence strips
  srand(seed);
  G = {
    seed, depth: 3, phase: 'descent', turn: 0,
    p: {
      x: 20, y: 12, hp: 30, hpMax: 34,
      skills: { MELEE: 4, EVASION: 2, STEALTH: 2, GRIT: 2 },
      xp: 120, xpTotal: 320, spent: [],
      weapon: 2, armor: 1, potions: [1, 1, 1],
      lamp: 3, power: 700, powerMax: 1200,
      shard: false, veil: 0, haste: 0, webbed: 0, moved: false,
      kills: 2, sights: { drone: 1, hound: 1 }, deaths: null,
    },
    map: new Uint8Array(MW * MH), explored: new Uint8Array(MW * MH), visible: new Uint8Array(MW * MH),
    mons: [], items: [], log: [], noiseQ: [], pulseIn: 0, gazeIn: 0, vorl: null,
    stats: { timesSpotted: 0, fights: 0, floorsTurns: [] },
  };
  for (let y = 8; y <= 16; y++) for (let x = 12; x <= 38; x++) setT(x, y, T_FLOOR);
  computeFOV();
}

const STAGES = {
  title() { scene = 'title'; anim.t = 2.2; },
  floor1() { newGame(11); scene = 'play'; stageWalk([[1, 0], [1, 0], [0, 1], [1, 0], [1, 0], [1, 0], [0, 1], [1, 0], [1, 0], [1, 0], [0, 0]]); anim.t = 1.3; },
  combat(f) {
    // frames 0: assassination of a sleeper · 1-3: waking hound takes hits · 4-7: hound answers
    stageArena(77);
    scene = 'play';
    const h = makeMon('hound', 21, 12, true);
    h.state = 'hunt'; h.tx = 20; h.ty = 12;
    h.hp = 99;                      // evidence dummy: the strip must outlive the dice
    if (f === 0) { h.asleep = true; h.state = 'unaware'; }
    G.mons.push(h);
    log(f === 0 ? 'A HOUND sleeps in the open. Your blade is out.' : 'The fight is joined.', '#f4e04a');
    for (let i = 0; i < f; i++) {
      if (i === 0) { h.asleep = true; h.state = 'unaware'; }   // first exchange is the assassination
      if (i <= 3) { h.stun = 2; playerTurn({ type: 'move', dx: 1, dy: 0 }); }
      else { h.stun = 0; h.state = 'hunt'; h.tx = G.p.x; h.ty = G.p.y; playerTurn({ type: 'wait' }); }
      if (i < f - 1) ageFx(0.5);
    }
    anim.t = 0.9; anim.floats.length = 0; anim.shake = 0;
  },
  alert(f) {
    stageArena(41);
    scene = 'play';
    const h = makeMon('hound', 30, 12, false);
    h.asleep = true; h.state = 'unaware';
    G.mons.push(h);
    G.p.x = 22; G.p.lamp = 3;
    computeFOV();
    log('Something sleeps ahead. Your lamp is bright.', '#9fb4cc');
    for (let i = 0; i < f; i++) { playerTurn({ type: 'move', dx: 1, dy: 0 }); if (i < f - 1) ageFx(0.5); }
    anim.t = 0.7; anim.floats.length = 0; anim.shake = 0;
  },
  stealth() {
    newGame(23); scene = 'play';
    // dim lamp, veil on, sneak posture next to a sleeping hound
    G.p.lamp = 1; G.p.veil = 20;
    const r = G.mons.find(m => m.asleep);
    if (r) { G.p.x = clamp(r.x + 2, 1, MW - 2); G.p.y = r.y; }
    computeFOV();
    log('VEIL holds. You slip past the sleepers.', '#c86bff');
    anim.t = 1.6;
  },
  sentinel() {
    stageArena(55); scene = 'play';
    const s = makeMon('sentinel', 25, 12, true);   // dist 5 — inside its range 6
    s.state = 'hunt'; G.mons.push(s);
    G.p.lamp = 4; computeFOV();
    monsterAct(s);                // charge telegraph
    ageFx(0.15);
    monsterAct(s);                // the lance fires
    log('The SENTINEL fires down the corridor.', '#ffb03a');
    anim.t = 0.4;
  },
  dark() {
    newGame(31); scene = 'play';
    G.p.power = 0; G.p.lamp = 1; G.p.hp = 9;
    computeFOV();
    log('Your lamp is dead. The dark gnaws.', '#ff8a8a');
    anim.t = 2.0;
  },
  vault() {
    newGame(1); scene = 'play';
    while (G.depth < 8) { G.stats.floorsTurns.push(G.turn); descend(); }
    // stand before the dais
    for (let i = 0; i < MW * MH; i++) if (G.map[i] === T_DAIS) { G.p.x = i % MW; G.p.y = ((i / MW) | 0) + 2; break; }
    G.p.lamp = 2; G.p.weapon = 2; G.p.armor = 2;
    computeFOV();
    log('The Vault. VORL sleeps on its throne of light.', '#ffd34a');
    anim.t = 1.8;
  },
  grab() {
    STAGES.vault();
    playerTurn({ type: 'move', dx: 0, dy: -1 });
    playerTurn({ type: 'move', dx: 0, dy: -1 });
    playerTurn({ type: 'stairs' });
    anim.t = 0.5; anim.grabT = 1.6;
  },
  pursuit() {
    STAGES.grab();
    // out of the vault and one floor up, hunters closing
    G.vorl = null; G.depth = 6; G.phase = 'escape';
    const { map, rooms } = genFloor(6, true);
    G.map = map; G.explored = new Uint8Array(MW * MH); G.visible = new Uint8Array(MW * MH);
    const e = rooms[0]; G.p.x = e.x + 2; G.p.y = e.y + 2;
    const up = farthestFloorTile(G.map, G.p.x, G.p.y);
    setT(up % MW, (up / MW) | 0, T_UP);
    G.mons = [];
    srand(999);
    for (const [dx, dy] of [[4, 0], [5, 1], [3, 2], [6, 3]]) {
      const h = makeMon('hunter', clamp(G.p.x + dx, 1, MW - 2), clamp(G.p.y + dy, 1, MH - 2), true);
      h.state = 'hunt'; h.tx = G.p.x; h.ty = G.p.y;
      if (WALKABLE(at(h.x, h.y))) G.mons.push(h);
    }
    computeFOV();
    log('The Shard sings. They hear.', '#ff8a5a');
    log('HUNTERS. Three floors to daylight.', '#ff4a4a');
    anim.t = 1.1; anim.alarmT = 0.7;
  },
  flash() {
    STAGES.pursuit();
    playerTurn({ type: 'potion', i: 2 });
    anim.t = 0.15; anim.flashT = 0.35;
  },
  skills() {
    newGame(17); scene = 'play';
    G.p.xp = 260;
    overlay = 'skills';
    anim.t = 1.0;
  },
  death() {
    newGame(66); scene = 'play';
    stageWalk([[1, 0], [0, 1], [1, 0], [0, 0]]);     // a real run: turns on the clock
    G.p.hp = 9;
    const h = makeMon('warden', G.p.x + 1, G.p.y, true);
    h.state = 'hunt'; h.tx = G.p.x; h.ty = G.p.y; G.mons.push(h);
    computeFOV();
    for (let i = 0; i < 300 && scene === 'play'; i++) { playerTurn({ type: 'wait' }); if (scene === 'play') ageFx(0.5); }
    anim.t = 0.3; anim.deathT = 0;
  },
  deathbanner() {
    STAGES.death();
    anim.deathT = 1.5;
  },
  win() {
    newGame(5); scene = 'play';
    G.p.shard = true; G.phase = 'escape'; G.depth = 1;
    G.turn = 1487; G.p.kills = 11; G.stats.timesSpotted = 6;
    G.p.skills = { MELEE: 4, EVASION: 4, STEALTH: 3, GRIT: 2 };
    G.p.hpMax = 22 + 6 * G.p.skills.GRIT; G.p.hp = G.p.hpMax;   // the summary must agree with the HUD
    winGame();
    anim.winT = 1.4;
  },
};

function runShot() {
  const f = +(Q.get('f') || 0);
  const name = SHOT;
  overlay = null;
  if (STAGES[name]) STAGES[name](f);
  else { STAGES.title(); }
  // settle particles a little for staged frames
  render(0.016);
  render(0.016);
}

// ==================================================================
// MAIN
// ==================================================================
if (AUTOPLAY) {
  runAutoplay();
} else if (SHOT) {
  runShot();
} else {
  if (Q.get('seed')) { /* deterministic play: seed applied on Enter */ }
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    render(dt);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
