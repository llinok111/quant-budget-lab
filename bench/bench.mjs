// Timing harness: payload planning = per-primitive quantize + exact-bit pack.
// cold = very first call (excluded from median), then 3 warmup + 9 measured runs.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as core from '../src/core.mjs';

const scene = JSON.parse(readFileSync(new URL('../data/scene.json', import.meta.url)));
const prims = scene.primitives.map((p) => ({
  name: p.name, positions: Float64Array.from(p.positions), indices: Uint32Array.from(p.indices),
}));
const BUDGET = 24576;

function planPayload(prims, budget) {
  const alloc = core.allocateBits(prims, budget);
  let bytes = 0, codes = 0;
  const packed = [];
  for (let i = 0; i < prims.length; i++) {
    const q = core.quantizePrimitive(prims[i].positions, alloc.bits[i]);
    const buf = core.packCodes(q.codes, alloc.bits[i]);
    packed.push(buf);
    bytes += buf.length; codes += q.codes.length;
  }
  return { bytes, codes, bits: alloc.bits, maxErrBound: alloc.maxErrBound, alloc, packed };
}

const tCold = performance.now();
const coldOut = planPayload(prims, BUDGET);
const coldMs = performance.now() - tCold;
for (let w = 0; w < 3; w++) planPayload(prims, BUDGET); // JIT warmup

const runs = [];
for (let r = 0; r < 9; r++) {
  const t = performance.now();
  const out = planPayload(prims, BUDGET);
  runs.push({ ms: performance.now() - t, bytes: out.bytes });
}

const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
const min = sorted[0];
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
const stddev = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length);
const relStddev = stddev / mean;

// Strategy comparison (includes the sampled surface oracle; measured once).
const budgeted = core.buildPlan(prims, BUDGET, { samples: 160 });
const uniform = core.buildPlan(prims, BUDGET, { samples: 160, strategy: 'uniform' });
const globalg = core.buildPlan(prims, BUDGET, { samples: 160, strategy: 'global' });

// Bytes the uniform-bit baseline needs to reach the budgeted plan's bound.
let uniformBytesForSameBound = null, uniformBitsForSameBound = null;
for (const b of core.DEFAULT_BITS) {
  const bytes = prims.reduce((s, p) => s + core.packedBytes(p.positions.length / 3, b), 0);
  if (Math.max(...prims.map((p) => core.quantizePrimitive(p.positions, b).errBound)) <= budgeted.maxErrBound) {
    uniformBytesForSameBound = bytes; uniformBitsForSameBound = b; break;
  }
}

const planSha = createHash('sha256').update(JSON.stringify({
  bits: budgeted.primitives.map((p) => p.bits),
  bytes: budgeted.primitives.map((p) => p.bytes),
  bound: budgeted.maxErrBound,
})).digest('hex');

const result = {
  generated_at: new Date().toISOString(),
  scene: { file: 'data/scene.json', sha256: createHash('sha256').update(JSON.stringify(scene)).digest('hex'),
    primitives: prims.length,
    vertices: prims.reduce((s, p) => s + p.positions.length / 3, 0),
    triangles: prims.reduce((s, p) => s + p.indices.length / 3, 0) },
  budget_bytes: BUDGET,
  timing: { unit: 'ms', op: 'allocateBits + quantizePrimitive + packCodes for all 24 primitives',
    cold_ms: Number(coldMs.toFixed(3)), runs_ms: runs.map((r) => Number(r.ms.toFixed(3))),
    min_ms: Number(min.toFixed(3)), median_ms: Number(median.toFixed(3)), p95_ms: Number(p95.toFixed(3)),
    mean_ms: Number(mean.toFixed(3)), stddev_ms: Number(stddev.toFixed(3)), rel_stddev: Number(relStddev.toFixed(4)),
    samples: runs.length + 1, warmup: 3, note: 'cold is excluded from the median' },
  strategies: {
    budgeted: { bits: budgeted.primitives.map((p) => p.bits), total_bytes: budgeted.totalBytes,
      max_err_bound: budgeted.maxErrBound, max_surface_error: budgeted.maxSurfaceError,
      surface_samples_per_primitive: 160, feasible: budgeted.feasible },
    uniform: { bits: uniform.primitives.map((p) => p.bits), total_bytes: uniform.totalBytes,
      max_err_bound: uniform.maxErrBound, max_surface_error: uniform.maxSurfaceError },
    global_grid: { bits: globalg.primitives.map((p) => p.bits), total_bytes: globalg.totalBytes,
      max_err_bound: globalg.maxErrBound, max_surface_error: globalg.maxSurfaceError },
  },
  claims: {
    bound_ratio_vs_uniform: Number((uniform.maxErrBound / budgeted.maxErrBound).toFixed(4)),
    surface_ratio_vs_uniform: Number((uniform.maxSurfaceError / budgeted.maxSurfaceError).toFixed(4)),
    bound_ratio_vs_global_grid: Number((globalg.maxErrBound / budgeted.maxErrBound).toFixed(4)),
    surface_ratio_vs_global_grid: Number((globalg.maxSurfaceError / budgeted.maxSurfaceError).toFixed(4)),
    uniform_bytes_for_same_bound: uniformBytesForSameBound,
    uniform_bits_for_same_bound: uniformBitsForSameBound,
    bytes_saved_at_same_bound: Number((100 * (1 - BUDGET / uniformBytesForSameBound)).toFixed(2)),
  },
  plan_sha256: planSha,
};

writeFileSync(new URL('./result.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(`cold ${result.timing.cold_ms} ms | median ${result.timing.median_ms} ms | p95 ${result.timing.p95_ms} ms | relSD ${(100 * relStddev).toFixed(1)}%`);
console.log(`budgeted ${budgeted.totalBytes} B, bound ${budgeted.maxErrBound.toExponential(4)}, surface ${budgeted.maxSurfaceError.toExponential(4)}`);
console.log(`vs uniform: ${result.claims.bound_ratio_vs_uniform}x lower bound | vs global grid: ${result.claims.bound_ratio_vs_global_grid}x`);
console.log(`plan sha256 ${planSha}`);