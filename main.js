// Rendering + interaction only. All geometry/error/byte math comes from src/core.mjs.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as core from './src/core.mjs';

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(view.clientWidth, view.clientHeight);
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);
scene.fog = new THREE.Fog(0x0e1116, 900, 2200);

const camera = new THREE.PerspectiveCamera(42, view.clientWidth / view.clientHeight, 1, 6000);
camera.position.set(430, -520, 380);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 40);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1b2430, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(300, -420, 600); scene.add(key);
const rim = new THREE.DirectionalLight(0x6ea8ff, 1.1); rim.position.set(-500, 300, 200); scene.add(rim);
const grid = new THREE.GridHelper(900, 18, 0x1f2a36, 0x161d25); grid.position.z = -6; scene.add(grid);

const state = { mode: 'budgeted', budgetBytes: 24576, plan: null, meshes: [], selected: -1 };

const el = (id) => document.getElementById(id);
const fmt = (v) => (v === 0 ? '0' : v.toExponential(3));

// heat: 8 bits -> orange, 16 bits -> blue
function bitColor(bits) {
  const t = Math.max(0, Math.min(1, (bits - 8) / 8));
  return new THREE.Color().setHSL(0.09 + 0.5 * t, 0.72, 0.42 + 0.12 * t);
}

let prims = [];
let worldDiag = 1;

async function boot() {
  const resp = await fetch('./data/scene.json');
  prims = (await resp.json()).primitives.map((p) => ({
    name: p.name,
    positions: Float64Array.from(p.positions),
    indices: Uint32Array.from(p.indices),
  }));
  let all = [];
  for (const p of prims) all = all.concat(Array.from(p.positions));
  worldDiag = core.diagonal(all);
  applyBudget();
  resize();
  renderer.setAnimationLoop(tick);
}

function disposeMeshes() {
  for (const m of state.meshes) { m.geometry.dispose(); m.material.dispose(); scene.remove(m); }
  state.meshes = [];
}

function buildPlan() {
  const plan = core.buildPlan(prims, state.budgetBytes, {
    strategy: state.mode, samples: 160,
  });
  state.plan = plan;
  const needs = plan.primitives.map((p, i) => {
    const q = core.quantizePrimitive(prims[i].positions, p.bits);
    const deq = state.mode === 'global' ? core.dequantizePrimitive(q) : core.dequantizePrimitive(q);
    return deq;
  });
  return { plan, needs };
}

function applyBudget() {
  el('budgetLabel').textContent = `${(state.budgetBytes / 1024).toFixed(1)} KiB`;
  const { plan, needs } = buildPlan();
  el('err').textContent = '';
  disposeMeshes();

  const hist = new Map();
  plan.primitives.forEach((p, i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(needs[i]), 3));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(prims[i].indices), 1));
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: bitColor(p.bits), metalness: 0.55, roughness: 0.42,
      flatShading: false,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.userData.prim = i;
    mesh.userData.bits = p.bits;
    scene.add(mesh);
    state.meshes.push(mesh);
    hist.set(p.bits, (hist.get(p.bits) || 0) + 1);
  });

  // error wireframe overlay on the worst primitive
  let worst = 0;
  plan.primitives.forEach((p, i) => { if (p.surfaceMax > plan.primitives[worst].surfaceMax) worst = i; });
  const wg = state.meshes[worst].geometry.clone();
  const wf = new THREE.LineSegments(new THREE.WireframeGeometry(wg), new THREE.LineBasicMaterial({ color: 0xf0883e, transparent: true, opacity: 0.35 }));
  wf.userData.isOverlay = true;
  scene.add(wf);

  el('s-bytes').textContent = `${plan.totalBytes} B (${(100 * plan.totalBytes / (prims.reduce((s, p) => s + p.positions.length, 0) * 4)).toFixed(1)}% of f32)`;
  el('s-bound').textContent = fmt(plan.maxErrBound);
  el('s-rel').textContent = `${(100 * plan.maxErrBound / worldDiag).toFixed(4)}%`;
  el('s-surf').textContent = fmt(plan.maxSurfaceError);

  const canonical = JSON.stringify({
    bits: plan.primitives.map((p) => p.bits),
    bytes: plan.primitives.map((p) => p.bytes),
    bound: plan.maxErrBound,
  });
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)).then((h) => {
    const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
    el('s-sha').textContent = hex.slice(0, 16) + '…';
    el('s-sha').title = hex;
  });

  // legend + table
  const legend = el('legend'); legend.innerHTML = '';
  for (let b = 8; b <= 16; b++) {
    const d = document.createElement('div');
    d.style.background = '#' + bitColor(b).getHexString();
    d.title = `${b} bits: ${hist.get(b) || 0} primitives`;
    legend.appendChild(d);
  }
  const rows = plan.primitives.map((p, i) => {
    const rel = (p.surfaceMax / core.diagonal(prims[i].positions)) * 100;
    return `<tr><td>${p.name}</td><td>${p.bits} b</td><td>${rel.toFixed(3)}%</td></tr>`;
  });
  el('bits').innerHTML = '<tr class="muted"><td>primitive</td><td>bits</td><td>surf err / diag</td></tr>' + rows.join('');

  // sanity: if the shared-grid baseline cannot even fit, say so
  if (!plan.feasible) el('err').textContent = 'infeasible at this budget';
}

el('budget').addEventListener('input', (e) => {
  state.budgetBytes = Number(e.target.value) * 1024;
  applyBudget();
});
for (const mode of ['budgeted', 'uniform', 'global']) {
  el(`m-${mode}`).addEventListener('click', () => {
    state.mode = mode;
    for (const m of ['budgeted', 'uniform', 'global']) el(`m-${m}`).classList.toggle('on', m === mode);
    applyBudget();
  });
}

// picking: report which primitive was clicked using a ray against the real meshes
const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', (e) => {
  const r = renderer.domElement.getBoundingClientRect();
  ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  const hit = ray.intersectObjects(state.meshes, false)[0];
  if (!hit) return;
  const i = hit.object.userData.prim;
  const p = state.plan.primitives[i];
  el('err').textContent = `${p.name}: ${p.bits} bits, bound ${fmt(p.errBound)}, sampled surface ${fmt(p.surfaceMax)}`;
});

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

const q = new URLSearchParams(location.search);
if (q.get('budget')) state.budgetBytes = Number(q.get('budget')) * 1024;
if (q.get('mode')) state.mode = q.get('mode');

function tick() {
  controls.update();
  renderer.render(scene, camera);
}

boot().catch((e) => {
  el('err').textContent = 'boot failed: ' + e.message;
  console.error(e);
});

export { state, applyBudget };