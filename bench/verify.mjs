// Assertions over the real generated scene. Exit 0 only if every check passes.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as core from '../src/core.mjs';

const raw = readFileSync(new URL('../data/scene.json', import.meta.url));
const scene = JSON.parse(raw);
const prims = scene.primitives.map((p) => ({
  name: p.name, positions: Float64Array.from(p.positions), indices: Uint32Array.from(p.indices),
}));
const BUDGET = 24576;
const BITS = core.DEFAULT_BITS;

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS ${name}: ${detail}`); }
  else { fail++; console.log(`FAIL ${name}: ${detail}`); }
};
const f = (v, d = 6) => Number(v).toPrecision(Math.max(d, 3));

// ---- 1. scene shape (the fixture is real, not synthetic noise) ----
const verts = prims.reduce((s, p) => s + p.positions.length / 3, 0);
ok('scene-shape', prims.length === 24 && verts === 4782,
  `${prims.length} primitives, ${verts} vertices, ${prims.reduce((s, p) => s + p.indices.length / 3, 0)} triangles`);

// ---- 2. bit packing is lossless at every bit depth ----
let packBad = 0, packChecked = 0;
for (const p of prims) for (const b of [8, 9, 12, 13, 16]) {
  const q = core.quantizePrimitive(p.positions, b);
  const back = core.unpackCodes(core.packCodes(q.codes, b), p.positions.length / 3, b);
  packChecked += back.length;
  for (let i = 0; i < back.length; i++) if (back[i] !== q.codes[i]) packBad++;
}
ok('bitpack-lossless', packBad === 0, `${packChecked} codes across ${prims.length}x5 depths, ${packBad} mismatches`);

// ---- 3. budgeted allocation: within budget, bound <= 6 ksi-ish, surface error <= bound ----
const t0 = Date.now();
const budgeted = core.buildPlan(prims, BUDGET, { samples: 160 });
const budgetedMs = Date.now() - t0;
ok('budgeted-fits', budgeted.feasible && budgeted.totalBytes <= BUDGET,
  `${budgeted.totalBytes} B <= ${BUDGET} B (${(100 * budgeted.totalBytes / BUDGET).toFixed(1)}% of budget, ${(100 * budgeted.ratioOfFloat32).toFixed(1)}% of float32)`);
ok('budgeted-roundtrip', budgeted.primitives.every((p) => p.roundTripMismatch === 0),
  `${budgeted.primitives.length} primitives, 0 code mismatches after pack/unpack`);
ok('surface-within-bound', budgeted.primitives.every((p) => p.surfaceMax <= p.errBound * (1 + 1e-9)),
  `max sampled surface ${f(budgeted.maxSurfaceError)} <= vertex bound ${f(budgeted.maxErrBound)} on all ${budgeted.primitives.length} primitives`);
const tightest = Math.max(...budgeted.primitives.map((p) => p.surfaceMax / p.errBound));
ok('bound-is-tight', tightest > 0.3 && tightest <= 1,
  `worst sampled/bound ratio ${tightest.toFixed(4)} (a bound that is never approached would be vacuous)`);

// ---- 4. same budget, uniform bits: measured comparison ----
const uniform = core.buildPlan(prims, BUDGET, { samples: 160, strategy: 'uniform' });
ok('uniform-fits', uniform.totalBytes <= BUDGET, `uniform bits=${uniform.primitives[0].bits} uses ${uniform.totalBytes} B`);
const ratioU = uniform.maxErrBound / budgeted.maxErrBound;
const ratioUs = uniform.maxSurfaceError / budgeted.maxSurfaceError;
ok('beats-uniform', ratioU >= 3,
  `max bound ${f(budgeted.maxErrBound)} vs ${f(uniform.maxErrBound)} = ${ratioU.toFixed(2)}x lower; sampled surface ${f(budgeted.maxSurfaceError)} vs ${f(uniform.maxSurfaceError)} = ${ratioUs.toFixed(2)}x`);

// ---- 5. same budget, one shared world grid (the naive asset-pipeline baseline) ----
const globalg = core.buildPlan(prims, BUDGET, { samples: 160, strategy: 'global' });
const ratioG = globalg.maxErrBound / budgeted.maxErrBound;
ok('beats-global-grid', ratioG >= 5,
  `shared-grid bound ${f(globalg.maxErrBound)} vs per-primitive ${f(budgeted.maxErrBound)} = ${ratioG.toFixed(2)}x lower`);

// ---- 6. equal error target: uniform needs more bytes (or cannot reach it) ----
const target = budgeted.maxErrBound;
let uniformBytesForTarget = Infinity, uniformBitsForTarget = null;
for (const b of BITS) {
  const bytes = prims.reduce((s, p) => s + core.packedBytes(p.positions.length / 3, b), 0);
  const err = Math.max(...prims.map((p) => core.quantizePrimitive(p.positions, b).errBound));
  if (err <= target) { uniformBytesForTarget = bytes; uniformBitsForTarget = b; break; }
}
const savings = uniformBytesForTarget === Infinity ? Infinity : 1 - BUDGET / uniformBytesForTarget;
ok('equal-error-savings', uniformBytesForTarget > BUDGET,
  `to reach bound ${f(target)} uniform needs ${uniformBitsForTarget} bits = ${uniformBytesForTarget} B vs budgeted ${BUDGET} B (${uniformBytesForTarget === Infinity ? 'unreachable' : (-100 * savings).toFixed(2) + '% fewer bytes'})`);

// ---- 7. scale invariance across 12 orders of magnitude ----
// Errors must scale exactly with the geometry; bit decisions must not change.
const baseBits = budgeted.primitives.map((p) => p.bits).join(',');
const scales = [1e-6, 1e-3, 1, 1e3, 1e6];
const scaleRows = [];
let scaleBad = 0;
for (const s of scales) {
  const sp = prims.map((p) => ({ ...p, positions: p.positions.map((v) => v * s) }));
  const plan = core.buildPlan(sp, BUDGET, { samples: 48 });
  const relBounds = plan.primitives.map((p) => (p.errBound / s) / (budgeted.primitives[plan.primitives.indexOf(p)].errBound));
  const bitsSame = plan.primitives.map((p) => p.bits).join(',') === baseBits;
  const maxRel = Math.max(...relBounds.map((r) => Math.abs(r - 1)));
  if (!bitsSame || maxRel > 1e-9) scaleBad++;
  scaleRows.push({ scale: s, bitsSame, boundPerUnitRelErr: Number(maxRel.toExponential(2)), maxSurfPerUnit: plan.maxSurfaceError / s });
}
ok('scale-invariance', scaleBad === 0,
  `5 scales 1e-6..1e6: identical bit decisions=${scaleRows.every((r) => r.bitsSame)}, worst |bound/s ratio - 1| = ${Math.max(...scaleRows.map((r) => r.boundPerUnitRelErr)).toExponential(2)}`);
console.log('     ' + scaleRows.map((r) => `s=${r.scale}: surf/s=${f(r.maxSurfPerUnit)}`).join(' | '));

// ---- 7b. allocator optimality vs exhaustive search on a 6-primitive sub-instance ----
// 9^6 = 531,441 combinations — small enough to enumerate, large enough that a
// greedy/naive allocator would not land on the same answer by luck.
const sub = prims.slice(0, 6);
const subBudget = Math.round(sub.reduce((s, p) => s + core.packedBytes(p.positions.length / 3, 12), 0) * 0.85);
const subAlloc = core.allocateBits(sub, subBudget);
let bruteMin = Infinity, bruteCombo = null;
const rec = (i, bits, bytes, err) => {
  if (bytes > subBudget) return;
  if (i === sub.length) { if (err < bruteMin) { bruteMin = err; bruteCombo = bits.slice(); } return; }
  for (const b of BITS) {
    const q = core.quantizePrimitive(sub[i].positions, b);
    const nb = bytes + core.packedBytes(sub[i].positions.length / 3, b);
    if (nb > subBudget) continue;
    bits.push(b); rec(i + 1, bits, nb, Math.max(err, q.errBound)); bits.pop();
  }
};
rec(0, [], 0, 0);
const optimal = Math.abs(bruteMin - subAlloc.maxErrBound) <= 1e-12 * Math.max(1, bruteMin);
ok('optimal-vs-bruteforce', optimal,
  `6 primitives, budget ${subBudget} B, 531441 combos: allocator bound ${f(subAlloc.maxErrBound)} vs exhaustive optimum ${f(bruteMin)} (delta ${Math.abs(bruteMin - subAlloc.maxErrBound).toExponential(2)})`);
console.log(`     exhaustive optimum bits = [${bruteCombo.join(',')}] | allocator bits = [${subAlloc.bits.join(',')}]`);

// ---- 8. determinism: two plans are byte-identical ----
const again = core.buildPlan(prims, BUDGET, { samples: 160 });
const sha = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex');
ok('deterministic', sha(again) === sha(budgeted), `two plans sha256 ${sha(budgeted).slice(0, 16)}... identical`);

// ---- 9. tiny parts: the case a global grid destroys ----
const smallest = prims.reduce((a, p) => (core.diagonal(p.positions) < core.diagonal(a.positions) ? p : a));
const sIdx = prims.indexOf(smallest);
const boltBudgeted = budgeted.primitives[sIdx];
const boltGlobal = globalg.primitives[sIdx];
ok('small-part-relative-error', boltBudgeted.surfaceMax / core.diagonal(smallest.positions) < 0.01 &&
  (boltGlobal.surfaceMax / core.diagonal(smallest.positions)) > 5 * (boltBudgeted.surfaceMax / core.diagonal(smallest.positions)),
  `${smallest.name} (diag ${f(core.diagonal(smallest.positions))}): per-prim surface err ${f(boltBudgeted.surfaceMax)} (${(100 * boltBudgeted.surfaceMax / core.diagonal(smallest.positions)).toFixed(3)}% of diag) vs shared-grid ${f(boltGlobal.surfaceMax)}`);

console.log(`\nscene sha256 ${createHash('sha256').update(raw).digest('hex').slice(0, 16)}... | budgeted plan ${budgetedMs} ms (incl. 160x24 surface samples)`);
console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);