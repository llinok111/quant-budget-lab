// Deterministic sample scene: a 24-primitive mechanical plate with tiny bolt
// heads far from the origin. This is the case where one shared world grid fails:
// the bolts span 5 units inside a 780-unit world.
//   node tools/gen-sample.mjs   -> data/scene.json  (byte-identical on re-run)
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

function mesh(name, positions, indices) { return { name, positions, indices }; }

function box(w, h, d, nx, ny) {
  const pos = [], idx = [];
  const push = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  // top + bottom grids
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const x = -w / 2 + (w * i) / nx, y = -h / 2 + (h * j) / ny;
    push(x, y, d / 2); push(x, y, -d / 2);
  }
  const stride = (nx + 1);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * stride + i, b = a + 1, c = a + stride, dd = c + 1;
    for (const layer of [0, 1]) {
      const o = layer * stride * (ny + 1);
      const A = a + o, B = b + o, C = c + o, D = dd + o;
      if (layer === 0) { idx.push(A, C, B, B, C, D); } else { idx.push(A, B, C, B, D, C); }
    }
  }
  // side walls
  const ring = (pts) => {
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k], q = pts[(k + 1) % pts.length];
      const a0 = push(...p, d / 2), a1 = push(...p, -d / 2), b0 = push(...q, d / 2), b1 = push(...q, -d / 2);
      idx.push(a0, b0, a1, b0, b1, a1);
    }
  };
  const edge = (x0, y0, x1, y1, n) => Array.from({ length: n }, (_, k) => {
    const t = k / n; return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  });
  const outline = [
    ...edge(-w / 2, -h / 2, w / 2, -h / 2, nx),
    ...edge(w / 2, -h / 2, w / 2, h / 2, ny),
    ...edge(w / 2, h / 2, -w / 2, h / 2, nx),
    ...edge(-w / 2, h / 2, -w / 2, -h / 2, ny),
  ];
  ring(outline);
  return mesh('plate', pos, idx);
}

function cylinder(radius, height, radial, caps = true) {
  const pos = [], idx = [];
  const push = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  const top = [], bot = [];
  for (let k = 0; k < radial; k++) {
    const a = (2 * Math.PI * k) / radial;
    const x = radius * Math.cos(a), z = radius * Math.sin(a);
    top.push(push(x, height / 2, z));
    bot.push(push(x, -height / 2, z));
  }
  for (let k = 0; k < radial; k++) {
    const n = (k + 1) % radial;
    idx.push(bot[k], top[k], bot[n], bot[n], top[k], top[n]);
  }
  if (caps) {
    const ct = push(0, height / 2, 0), cb = push(0, -height / 2, 0);
    for (let k = 0; k < radial; k++) {
      const n = (k + 1) % radial;
      idx.push(ct, top[n], top[k]);
      idx.push(cb, bot[k], bot[n]);
    }
  }
  return mesh('cyl', pos, idx);
}

function torus(R, r, nu, nv) {
  const pos = [], idx = [];
  const push = (x, y, z) => { pos.push(x, y, z); return pos.length / 3 - 1; };
  for (let i = 0; i < nu; i++) {
    const u = (2 * Math.PI * i) / nu;
    for (let j = 0; j < nv; j++) {
      const v = (2 * Math.PI * j) / nv;
      push((R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u));
    }
  }
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const a = i * nv + j, b = ((i + 1) % nu) * nv + j;
    const c = i * nv + ((j + 1) % nv), d = ((i + 1) % nu) * nv + ((j + 1) % nv);
    idx.push(a, b, c, b, d, c);
  }
  return mesh('torus', pos, idx);
}

function transform(m, tx, ty, tz, scale = 1) {
  const p = m.positions.slice();
  for (let i = 0; i < p.length; i += 3) { p[i] = p[i] * scale + tx; p[i + 1] = p[i + 1] * scale + ty; p[i + 2] = p[i + 2] * scale + tz; }
  return mesh(m.name, p, m.indices.slice());
}

// deterministic LCG, no Math.random
let seed = 20261117;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

const prims = [];
const plate = box(400, 300, 10, 24, 18);
prims.push(transform(plate, 0, 0, 0));

// 4 pillars (r=14, h=120) at plate corners
for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
  prims.push(transform(cylinder(14, 120, 48), sx * 170, sy * 125, 65));
}
// 3 gears (torus R=45 r=12) in the middle
for (let g = 0; g < 3; g++) prims.push(transform(torus(45, 12, 64, 12), -110 + g * 110, 0, 16 + (g % 2) * 18));
// 16 bolt heads (r=2.5, h=2) spread over the plate: tiny parts, far from origin
for (let i = 0; i < 16; i++) {
  const gx = -1 + (2 * (i % 4)) / 3, gy = -1 + (2 * Math.floor(i / 4)) / 3;
  prims.push(transform(cylinder(2.5, 2, 24), gx * 372 + (rnd() - 0.5) * 0.4, gy * 272 + (rnd() - 0.5) * 0.4, 6.5));
}
// name them
prims.forEach((p, i) => { p.name = `${p.name}-${String(i).padStart(2, '0')}`; });

const round = (v) => Math.round(v * 1e6) / 1e6;
for (const p of prims) p.positions = p.positions.map(round);

const scene = {
  generator: 'tools/gen-sample.mjs',
  seed: 20261117,
  units: 'mm (nominal); geometry is scale-free',
  primitives: prims,
};
mkdirSync('data', { recursive: true });
const json = JSON.stringify(scene);
writeFileSync('data/scene.json', json);
const h = createHash('sha256').update(json).digest('hex');
const verts = prims.reduce((s, p) => s + p.positions.length / 3, 0);
const tris = prims.reduce((s, p) => s + p.indices.length / 3, 0);
console.log(`data/scene.json  ${(json.length / 1024).toFixed(1)} KiB  sha256=${h}`);
console.log(`primitives=${prims.length} vertices=${verts} triangles=${tris}`);
console.log(`float32 positions would be ${((verts * 3 * 4) / 1024).toFixed(1)} KiB`);