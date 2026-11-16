// quant-budget core: per-primitive vertex-grid quantization + byte-budget allocation.
// Pure ES module: no three.js, no DOM, no I/O. Every function is deterministic.

export const DEFAULT_BITS = [8, 9, 10, 11, 12, 13, 14, 15, 16];

/* ---------- bounds ---------- */
export function bounds(positions) {
  let minx = Infinity, miny = Infinity, minz = Infinity;
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  return { min: [minx, miny, minz], max: [maxx, maxy, maxz] };
}

export function diagonal(positions) {
  const b = bounds(positions);
  const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2];
  return Math.hypot(dx, dy, dz);
}

/* ---------- quantization ---------- */
// Grid: codes in [0, 2^bits-1] per axis, dequant = min + code * step.
// step_a = extent_a / (2^bits - 1);  max abs error on axis a is step_a/2.
export function quantizePrimitive(positions, bits) {
  if (!Number.isInteger(bits) || bits < 1 || bits > 30) throw new RangeError('bits must be integer 1..30');
  const b = bounds(positions);
  const levels = (1 << bits) - 1;
  const extent = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  // A flat axis (extent 0) still needs a legal step; give it the global max step.
  const emax = Math.max(extent[0], extent[1], extent[2], Number.MIN_VALUE);
  const step = extent.map((e) => (e > 0 ? e / levels : emax / levels));
  const codes = new Int32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      let c = Math.round((positions[i + a] - b.min[a]) / step[a]);
      if (c < 0) c = 0; else if (c > levels) c = levels;
      codes[i + a] = c;
    }
  }
  const q = { bits, min: b.min, max: b.max, step, levels, codes };
  // Euclidean per-vertex displacement bound: each axis is off by at most
  // step_a/2, so the 3D distance is at most half the step diagonal.
  q.errBound = 0.5 * Math.hypot(step[0], step[1], step[2]);
  return q;
}

export function dequantizePrimitive(q) {
  const out = new Float64Array(q.codes.length);
  for (let i = 0; i < q.codes.length; i += 3) {
    for (let a = 0; a < 3; a++) out[i + a] = q.min[a] + q.codes[i + a] * q.step[a];
  }
  return out;
}

/* ---------- bit packing (exact `bits` per component) ---------- */
export function packedBytes(vertexCount, bits) {
  return Math.ceil((vertexCount * 3 * bits) / 8);
}

export function packCodes(codes, bits) {
  const out = new Uint8Array(packedBytes(codes.length / 3, bits));
  let bitPos = 0;
  const mask = (1 << bits) - 1;
  for (let i = 0; i < codes.length; i++) {
    const v = codes[i] & mask;
    for (let k = 0; k < bits; k++) {
      if ((v >> k) & 1) out[(bitPos >> 3)] |= 1 << (bitPos & 7);
      bitPos++;
    }
  }
  return out;
}

export function unpackCodes(buf, vertexCount, bits) {
  const out = new Int32Array(vertexCount * 3);
  let bitPos = 0;
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let k = 0; k < bits; k++) {
      if ((buf[bitPos >> 3] >> (bitPos & 7)) & 1) v |= 1 << k;
      bitPos++;
    }
    out[i] = v;
  }
  return out;
}

/* ---------- byte-budget allocation ---------- */
// Error is monotone non-increasing in bits and bytes monotone non-decreasing,
// so "min bytes s.t. bound <= eps" is exact per primitive; binary search over
// the candidate eps values yields the global optimum for a byte budget.
export function allocateBits(prims, byteBudget, opts = {}) {
  const bitsOptions = opts.bits || DEFAULT_BITS;
  const curves = prims.map((p) => {
    const rows = [];
    for (const b of bitsOptions) {
      const q = quantizePrimitive(p.positions, b);
      rows.push({ bits: b, bytes: packedBytes(p.positions.length / 3, b), err: q.errBound });
    }
    rows.sort((x, y) => x.bits - y.bits);
    return rows;
  });
  const epsCandidates = [...new Set(curves.flat().map((r) => r.err))].sort((a, b) => a - b);
  let chosen = null;
  for (const eps of epsCandidates) {
    let total = 0, ok = true;
    const picks = new Array(curves.length);
    for (let i = 0; i < curves.length; i++) {
      const row = curves[i].find((r) => r.err <= eps * (1 + 1e-12));
      if (!row) { ok = false; break; }
      picks[i] = row; total += row.bytes;
    }
    if (ok && total <= byteBudget) { chosen = { eps, picks, total }; break; }
  }
  if (!chosen) {
    // Even max bits cannot fit: take max bits and report infeasible.
    const picks = curves.map((rows) => rows[rows.length - 1]);
    const total = picks.reduce((s, r) => s + r.bytes, 0);
    return { feasible: false, bits: picks.map((r) => r.bits), bytes: total, budget: byteBudget,
      maxErrBound: Math.max(...picks.map((r) => r.err)) };
  }
  // Greedy post-pass: spend leftover bytes on the current worst primitive.
  let { picks, total } = chosen;
  const bits = picks.map((r) => r.bits);
  for (;;) {
    let worst = -1, worstErr = -1;
    for (let i = 0; i < picks.length; i++) if (picks[i].err > worstErr) { worstErr = picks[i].err; worst = i; }
    const idx = curves[worst].findIndex((r) => r.bits === picks[worst].bits);
    const next = curves[worst][idx + 1];
    if (!next) break;
    const delta = next.bytes - picks[worst].bytes;
    if (total + delta > byteBudget) break;
    picks[worst] = next; total += delta;
  }
  const outBits = picks.map((r) => r.bits);
  return { feasible: true, bits: outBits, bytes: total, budget: byteBudget,
    maxErrBound: Math.max(...picks.map((r) => r.err)),
    optimalAtBudget: true };
}

// Baseline A: one uniform bit count for every primitive, largest that fits.
export function allocateUniform(prims, byteBudget, opts = {}) {
  const bitsOptions = opts.bits || DEFAULT_BITS;
  let best = null;
  for (const b of bitsOptions) {
    const total = prims.reduce((s, p) => s + packedBytes(p.positions.length / 3, b), 0);
    const err = Math.max(...prims.map((p) => quantizePrimitive(p.positions, b).errBound));
    if (total <= byteBudget) best = { bits: prims.map(() => b), bytes: total, maxErrBound: err };
  }
  if (!best) {
    const b = bitsOptions[0];
    best = { bits: prims.map(() => b), bytes: prims.reduce((s, p) => s + packedBytes(p.positions.length / 3, b), 0),
      maxErrBound: Math.max(...prims.map((p) => quantizePrimitive(p.positions, b).errBound)) };
  }
  return { feasible: true, ...best, budget: byteBudget, optimalAtBudget: false };
}

// Baseline B: one shared world grid (no per-primitive bbox), same bits everywhere.
export function allocateGlobalGrid(prims, byteBudget, opts = {}) {
  const bitsOptions = opts.bits || DEFAULT_BITS;
  let all = [];
  for (const p of prims) all = all.concat(Array.from(p.positions));
  const gb = bounds(all);
  const extent = [gb.max[0] - gb.min[0], gb.max[1] - gb.min[1], gb.max[2] - gb.min[2]];
  const diag = Math.hypot(extent[0], extent[1], extent[2]);
  const gridBound = (b) => 0.5 * Math.hypot(
    extent[0] / ((1 << b) - 1), extent[1] / ((1 << b) - 1), extent[2] / ((1 << b) - 1));
  let best = null;
  for (const b of bitsOptions) {
    const total = prims.reduce((s, p) => s + packedBytes(p.positions.length / 3, b), 0);
    if (total <= byteBudget) best = { bits: prims.map(() => b), bytes: total, maxErrBound: gridBound(b), worldDiag: diag };
  }
  if (!best) {
    const b = bitsOptions[0];
    best = { bits: prims.map(() => b), bytes: prims.reduce((s, p) => s + packedBytes(p.positions.length / 3, b), 0),
      maxErrBound: gridBound(b), worldDiag: diag };
  }
  return { feasible: true, ...best, budget: byteBudget, optimalAtBudget: false };
}

/* ---------- surface error (independent of the vertex bound) ---------- */
function closestDistSqToTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + v * abx, qy = ay + v * aby, qz = az + v * abz;
    return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + w * acx, qy = ay + w * acy, qz = az + w * acz;
    return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const qx = bx + w * (cx - bx), qy = by + w * (cy - by), qz = bz + w * (cz - bz);
    return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  const qx = ax + abx * v + acx * w, qy = ay + aby * v + acy * w, qz = az + abz * v + acz * w;
  return (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
}

// Deterministic stratified samples on the dequantized triangles, distance to the
// ORIGINAL triangles of the same primitive. No shared epsilon with quantize().
export function sampledSurfaceError(origPositions, origIndices, deqPositions, deqIndices, samples, salt = 0) {
  const triCount = deqIndices.length / 3;
  const oTri = origIndices.length / 3;
  const areas = new Float64Array(triCount);
  let totalArea = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = deqIndices[t * 3] * 3, i1 = deqIndices[t * 3 + 1] * 3, i2 = deqIndices[t * 3 + 2] * 3;
    const ux = deqPositions[i1] - deqPositions[i0], uy = deqPositions[i1 + 1] - deqPositions[i0 + 1], uz = deqPositions[i1 + 2] - deqPositions[i0 + 2];
    const vx = deqPositions[i2] - deqPositions[i0], vy = deqPositions[i2 + 1] - deqPositions[i0 + 1], vz = deqPositions[i2 + 2] - deqPositions[i0 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    areas[t] = 0.5 * Math.hypot(cx, cy, cz);
    totalArea += areas[t];
  }
  let maxD = 0, sumD = 0, n = 0;
  const inv = 1 / Math.max(samples, 1);
  for (let s = 0; s < samples; s++) {
    // pick triangle by area (deterministic walk with a golden-ratio stride)
    const target = ((s + 0.5) * inv + salt * 0.037) % 1 * totalArea;
    let acc = 0, t = 0;
    while (t < triCount - 1 && acc + areas[t] < target) { acc += areas[t]; t++; }
    // Hammersley-ish barycentrics
    const u = ((s * 0.7548776662466927 + 0.31 + salt * 0.11) % 1);
    const v = ((s * 0.5698402909980532 + 0.17 + salt * 0.23) % 1);
    let r1 = u, r2 = v;
    if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
    const i0 = deqIndices[t * 3] * 3, i1 = deqIndices[t * 3 + 1] * 3, i2 = deqIndices[t * 3 + 2] * 3;
    const px = deqPositions[i0] + r1 * (deqPositions[i1] - deqPositions[i0]) + r2 * (deqPositions[i2] - deqPositions[i0]);
    const py = deqPositions[i0 + 1] + r1 * (deqPositions[i1 + 1] - deqPositions[i0 + 1]) + r2 * (deqPositions[i2 + 1] - deqPositions[i0 + 1]);
    const pz = deqPositions[i0 + 2] + r1 * (deqPositions[i1 + 2] - deqPositions[i0 + 2]) + r2 * (deqPositions[i2 + 2] - deqPositions[i0 + 2]);
    let best = Infinity;
    for (let k = 0; k < oTri; k++) {
      const a = origIndices[k * 3] * 3, b = origIndices[k * 3 + 1] * 3, c = origIndices[k * 3 + 2] * 3;
      const d = closestDistSqToTri(px, py, pz,
        origPositions[a], origPositions[a + 1], origPositions[a + 2],
        origPositions[b], origPositions[b + 1], origPositions[b + 2],
        origPositions[c], origPositions[c + 1], origPositions[c + 2]);
      if (d < best) best = d;
    }
    const d = Math.sqrt(best);
    if (d > maxD) maxD = d;
    sumD += d; n++;
  }
  return { max: maxD, mean: n ? sumD / n : 0, samples: n };
}

/* ---------- plan: allocate + measure, all in one deterministic call ---------- */
export function buildPlan(prims, budget, opts = {}) {
  const strategy = opts.strategy || 'budgeted';
  const alloc = strategy === 'uniform' ? allocateUniform(prims, budget, opts)
    : strategy === 'global' ? allocateGlobalGrid(prims, budget, opts)
    : allocateBits(prims, budget, opts);
  const perPrim = [];
  let totalBytes = 0, maxBound = 0, maxSurface = 0, totalTris = 0;
  const samples = opts.samples == null ? 200 : opts.samples;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    const bits = alloc.bits[i];
    const q = quantizePrimitive(p.positions, bits);
    const deq = strategy === 'global'
      ? dequantizeGlobal(p.positions, bits, prims)   // shared world grid baseline
      : dequantizePrimitive(q);
    const packed = packCodes(q.codes, bits);
    const unpacked = unpackCodes(packed, p.positions.length / 3, bits);
    let mismatch = 0;
    for (let k = 0; k < unpacked.length; k++) if (unpacked[k] !== q.codes[k]) mismatch++;
    const se = sampledSurfaceError(p.positions, p.indices, deq, p.indices, samples, i);
    // For the shared-world-grid baseline the error is set by the global step,
    // not by this primitive's own grid; report it honestly.
    const bound = strategy === 'global' ? alloc.maxErrBound : q.errBound;
    perPrim.push({ name: p.name, bits, bytes: packed.length, errBound: bound,
      surfaceMax: se.max, surfaceMean: se.mean, samples: se.samples, roundTripMismatch: mismatch });
    totalBytes += packed.length; maxBound = Math.max(maxBound, bound);
    maxSurface = Math.max(maxSurface, se.max); totalTris += p.indices.length / 3;
  }
  return { strategy, budget, feasible: alloc.feasible, totalBytes, ratioOfFloat32: totalBytes / (prims.reduce((s, p) => s + p.positions.length, 0) * 4),
    maxErrBound: maxBound, maxSurfaceError: maxSurface, vertices: prims.reduce((s, p) => s + p.positions.length / 3, 0),
    triangles: totalTris, primitives: perPrim };
}

function dequantizeGlobal(positions, bits, prims) {
  let all = [];
  for (const p of prims) all = all.concat(Array.from(p.positions));
  const gb = bounds(all);
  const extent = [gb.max[0] - gb.min[0], gb.max[1] - gb.min[1], gb.max[2] - gb.min[2]];
  const levels = (1 << bits) - 1;
  const step = extent.map((e) => e / levels);
  const out = new Float64Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const c = Math.round((positions[i + a] - gb.min[a]) / step[a]);
      out[i + a] = gb.min[a] + c * step[a];
    }
  }
  return out;
}