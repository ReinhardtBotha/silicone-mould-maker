import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { defaultParams, MouldParams, MouldResult } from './core/mould';
import { parseSTL, writeSTL } from './core/stl';
import type { Mesh } from './core/marching';
import MouldWorker from './worker?worker';

// ---------------------------------------------------------------- parameters UI
type NumKey = { [K in keyof MouldParams]: MouldParams[K] extends number ? K : never }[keyof MouldParams];
type BoolKey = { [K in keyof MouldParams]: MouldParams[K] extends boolean ? K : never }[keyof MouldParams];
interface NumDef { key: NumKey; label: string; min: number; max: number; step: number; unit?: string; tip: string }
interface BoolDef { key: BoolKey; label: string; tip: string }

const basic: (NumDef | BoolDef | 'split')[] = [
  { key: 'siliconeThickness', label: 'Silicone thickness', min: 2, max: 20, step: 0.5, unit: 'mm', tip: 'Gap between the master and the shell, filled with silicone.' },
  { key: 'wallThickness', label: 'Shell wall', min: 1.2, max: 6, step: 0.2, unit: 'mm', tip: 'Thickness of the printed shell.' },
  { key: 'smoothing', label: 'Shape smoothing', min: 0, max: 25, step: 1, unit: 'mm', tip: 'Bridges gaps and concave detail so the shell is simpler. 0 follows the model as closely as possible (least silicone).' },
  'split',
  { key: 'splitOffset', label: 'Split offset', min: -100, max: 100, step: 0.5, unit: 'mm', tip: 'Moves the split plane away from the model centre.' },
  { key: 'resolution', label: 'Quality', min: 80, max: 260, step: 10, tip: 'Grid cells along the longest side. Higher = smoother but slower and more memory.' },
];
const advanced: (NumDef | BoolDef)[] = [
  { key: 'flangeWidth', label: 'Flange width', min: 4, max: 25, step: 0.5, unit: 'mm', tip: 'How far the bolting flange sticks out from the shell.' },
  { key: 'flangeThickness', label: 'Flange thickness', min: 2, max: 10, step: 0.5, unit: 'mm', tip: 'Thickness of each flange half.' },
  { key: 'bolts', label: 'Bolt holes', tip: 'Add bolt holes through the flanges to clamp and align the halves.' },
  { key: 'boltDiameter', label: 'Bolt hole Ø', min: 2, max: 8, step: 0.1, unit: 'mm', tip: '3.4 mm suits M3 bolts.' },
  { key: 'boltSpacing', label: 'Bolt spacing', min: 10, max: 120, step: 1, unit: 'mm', tip: 'Minimum distance between bolts.' },
  { key: 'pourDiameter', label: 'Pour hole Ø', min: 4, max: 30, step: 0.5, unit: 'mm', tip: 'Placed automatically at the highest point of the cavity.' },
  { key: 'funnelHeight', label: 'Funnel height', min: 0, max: 40, step: 1, unit: 'mm', tip: 'Flared funnel above the pour hole (0 = just a hole).' },
  { key: 'vents', label: 'Auto vents', tip: 'Drill vent holes above every pocket where air would be trapped.' },
  { key: 'ventDiameter', label: 'Vent Ø', min: 1, max: 6, step: 0.1, unit: 'mm', tip: 'Diameter of the air vents.' },
  { key: 'ventMinPocket', label: 'Min air pocket', min: 0.3, max: 10, step: 0.1, unit: 'mm', tip: 'Ignore air pockets shallower than this.' },
  { key: 'baseThickness', label: 'Base thickness', min: 1.5, max: 10, step: 0.5, unit: 'mm', tip: 'Base plate thickness.' },
  { key: 'baseMargin', label: 'Base margin', min: 1, max: 20, step: 0.5, unit: 'mm', tip: 'How far the base plate extends beyond the flange.' },
  { key: 'baseRidge', label: 'Locating ridge', tip: 'Raised ridge on the base plate that the shell sits inside.' },
];

const params: MouldParams = { ...defaultParams };
try {
  Object.assign(params, JSON.parse(localStorage.getItem('mould-params') ?? '{}'));
} catch { /* ignore */ }
const saveParams = () => { try { localStorage.setItem('mould-params', JSON.stringify(params)); } catch { /* ignore */ } };

function renderParams(host: HTMLElement, defs: (NumDef | BoolDef | 'split')[]) {
  for (const d of defs) {
    const row = document.createElement('label');
    row.className = 'param';
    if (d === 'split') {
      row.innerHTML = `<span title="Plane the shell is cut along">Split plane</span>
        <select><option value="x">YZ plane (left / right)</option><option value="y">XZ plane (front / back)</option></select>`;
      const sel = row.querySelector('select')!;
      sel.value = params.splitAxis;
      sel.onchange = () => { params.splitAxis = sel.value as 'x' | 'y'; saveParams(); updateSplitPreview(); };
    } else if ('min' in d) {
      row.innerHTML = `<span title="${d.tip}">${d.label}</span><input type="number" min="${d.min}" max="${d.max}" step="${d.step}" value="${params[d.key]}" /><em>${d.unit ?? ''}</em>`;
      const inp = row.querySelector('input')!;
      inp.oninput = () => {
        const v = parseFloat(inp.value);
        if (!isNaN(v)) { params[d.key] = v; saveParams(); if (d.key === 'splitOffset') updateSplitPreview(); }
      };
    } else {
      row.innerHTML = `<span title="${d.tip}">${d.label}</span><input type="checkbox" ${params[d.key] ? 'checked' : ''} />`;
      const inp = row.querySelector('input')!;
      inp.onchange = () => { params[d.key] = inp.checked; saveParams(); };
    }
    host.appendChild(row);
  }
}
renderParams(document.getElementById('params')!, basic);
renderParams(document.getElementById('advParams')!, advanced);

// ---------------------------------------------------------------- viewer
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const view = document.getElementById('view')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d2026);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
camera.position.set(160, -220, 140);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, -1.5, 2);
camera.add(sun);
scene.add(camera);
const gridHelper = new THREE.GridHelper(400, 40, 0x3a3f4a, 0x2a2e36);
gridHelper.rotation.x = Math.PI / 2;
scene.add(gridHelper);

function resize() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  renderer.domElement.style.width = r.width + 'px';
  renderer.domElement.style.height = r.height + 'px';
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

const mat = (color: number, opts: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, side: THREE.DoubleSide, ...opts });

function toGeometry(positions: Float32Array, index?: Uint32Array) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (index) geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- model state
let rawTris: Float32Array | null = null; // as loaded
let tris: Float32Array | null = null; // oriented, scaled, sitting on z = 0, centred in xy
let modelName = 'model';
const rotation = new THREE.Matrix4();
let modelMesh: THREE.Mesh | null = null;
let splitPlane: THREE.Mesh | null = null;
let result: MouldResult | null = null;
const resultGroup = new THREE.Group();
scene.add(resultGroup);
const parts: Record<'halfA' | 'halfB' | 'base', THREE.Mesh | null> = { halfA: null, halfB: null, base: null };

function bounds(t: Float32Array) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3)
    for (let a = 0; a < 3; a++) {
      if (t[i + a] < min[a]) min[a] = t[i + a];
      if (t[i + a] > max[a]) max[a] = t[i + a];
    }
  return { min, max };
}

function rebuildModel() {
  if (!rawTris) return;
  const scale = parseFloat((document.getElementById('scale') as HTMLInputElement).value) || 1;
  const m = new THREE.Matrix4().makeScale(scale, scale, scale).premultiply(rotation);
  const out = new Float32Array(rawTris.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < rawTris.length; i += 3) {
    v.set(rawTris[i], rawTris[i + 1], rawTris[i + 2]).applyMatrix4(m);
    out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z;
  }
  // Scaling by a negative determinant would flip winding; rotations + uniform scale never do.
  const { min, max } = bounds(out);
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  for (let i = 0; i < out.length; i += 3) { out[i] -= cx; out[i + 1] -= cy; out[i + 2] -= min[2]; }
  tris = out;
  clearResult();
  if (modelMesh) { scene.remove(modelMesh); modelMesh.geometry.dispose(); }
  modelMesh = new THREE.Mesh(toGeometry(tris), mat(0xe0b070, { roughness: 0.5 }));
  scene.add(modelMesh);
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  document.getElementById('modelInfo')!.innerHTML =
    `<b>${modelName}</b><br>${(tris.length / 9).toLocaleString()} triangles · ${size.map((s) => s.toFixed(1)).join(' × ')} mm`;
  if (Math.max(...size) < 10) document.getElementById('modelInfo')!.innerHTML += '<br><span class="warn">Very small — is the model in inches or metres? Adjust the scale.</span>';
  (document.getElementById('generate') as HTMLButtonElement).disabled = false;
  document.getElementById('empty')?.remove();
  updateSplitPreview();
  frame(size);
}

function frame(size: number[]) {
  const r = Math.max(...size) * 1.1 + 40;
  controls.target.set(0, 0, size[2] / 2);
  camera.position.set(r * 1.2, -r * 1.7, size[2] / 2 + r * 0.9);
  controls.update();
}

function updateSplitPreview() {
  if (splitPlane) { scene.remove(splitPlane); splitPlane.geometry.dispose(); splitPlane = null; }
  if (!tris || result) return;
  const { min, max } = bounds(tris);
  const pad = params.siliconeThickness + params.wallThickness + params.flangeWidth;
  const w = (params.splitAxis === 'x' ? max[1] - min[1] : max[0] - min[0]) + 2 * pad;
  const hgt = max[2] - min[2] + pad;
  splitPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(w, hgt),
    new THREE.MeshBasicMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  splitPlane.rotation.x = Math.PI / 2;
  if (params.splitAxis === 'x') splitPlane.rotation.y = Math.PI / 2;
  const off = params.splitOffset + (params.splitAxis === 'x' ? (min[0] + max[0]) / 2 : (min[1] + max[1]) / 2);
  splitPlane.position.set(params.splitAxis === 'x' ? off : 0, params.splitAxis === 'y' ? off : 0, hgt / 2);
  scene.add(splitPlane);
}

function clearResult() {
  result = null;
  for (const c of [...resultGroup.children]) {
    resultGroup.remove(c);
    if (c instanceof THREE.Mesh) c.geometry.dispose();
  }
  parts.halfA = parts.halfB = parts.base = null;
  document.getElementById('results')!.classList.add('hidden');
}

async function loadFile(file: File) {
  modelName = file.name.replace(/\.stl$/i, '');
  rawTris = parseSTL(await file.arrayBuffer());
  if (rawTris.length === 0) { alert('Could not read any triangles from this file.'); return; }
  rotation.identity();
  rebuildModel();
}

const fileInput = document.getElementById('file') as HTMLInputElement;
fileInput.onchange = () => { if (fileInput.files?.[0]) loadFile(fileInput.files[0]); };
const drop = document.getElementById('drop')!;
for (const el of [drop, view]) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  el.addEventListener('dragleave', () => drop.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = (e as DragEvent).dataTransfer?.files[0];
    if (f) loadFile(f);
  });
}
document.querySelectorAll<HTMLButtonElement>('[data-rot]').forEach((b) => {
  b.onclick = () => {
    const axis = b.dataset.rot!;
    const r = new THREE.Matrix4();
    if (axis === 'x') r.makeRotationX(Math.PI / 2);
    else if (axis === 'y') r.makeRotationY(Math.PI / 2);
    else r.makeRotationZ(Math.PI / 2);
    rotation.premultiply(r);
    rebuildModel();
  };
});
(document.getElementById('scale') as HTMLInputElement).onchange = rebuildModel;
document.getElementById('inch')!.onclick = () => {
  (document.getElementById('scale') as HTMLInputElement).value = '25.4';
  rebuildModel();
};

// ---------------------------------------------------------------- worker
let worker: Worker | null = null;
const progressEl = document.getElementById('progress')!;
const genBtn = document.getElementById('generate') as HTMLButtonElement;

function newWorker() {
  worker?.terminate();
  worker = new MouldWorker();
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'demo') {
      rawTris = msg.tris;
      modelName = 'Demo teddy';
      rotation.identity();
      rebuildModel();
    } else if (msg.type === 'progress') {
      progressEl.classList.remove('hidden');
      (progressEl.firstElementChild as HTMLElement).style.width = `${msg.fraction * 100}%`;
      progressEl.querySelector('span')!.textContent = msg.stage;
    } else if (msg.type === 'result') {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate mould';
      progressEl.classList.add('hidden');
      showResult(msg.result);
    } else if (msg.type === 'error') {
      genBtn.disabled = false;
      genBtn.textContent = 'Generate mould';
      progressEl.classList.add('hidden');
      alert('Mould generation failed: ' + msg.message);
    }
  };
}
newWorker();

document.getElementById('demo')!.onclick = () => worker!.postMessage({ type: 'demo' });

genBtn.onclick = () => {
  if (!tris) return;
  genBtn.disabled = true;
  genBtn.textContent = 'Working…';
  clearResult();
  const copy = tris.slice();
  worker!.postMessage({ type: 'generate', tris: copy, params: { ...params } }, [copy.buffer]);
};

// ---------------------------------------------------------------- results
function showResult(res: MouldResult) {
  clearResult();
  result = res;
  if (splitPlane) { scene.remove(splitPlane); splitPlane = null; }
  const colors = { halfA: 0x4f9dde, halfB: 0x58c48a, base: 0x9aa3b5 };
  for (const k of ['halfA', 'halfB', 'base'] as const) {
    const m = new THREE.Mesh(toGeometry(res[k].positions, res[k].index), mat(colors[k], { transparent: true, opacity: 0.92 }));
    parts[k] = m;
    resultGroup.add(m);
  }
  const markerGeo = new THREE.SphereGeometry(1.6, 16, 12);
  const pourMarker = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0xffd34d }));
  pourMarker.position.set(res.pour.x, res.pour.y, res.pour.z);
  resultGroup.add(pourMarker);
  for (const t of res.traps) {
    const mk = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: t.vented ? 0x7be0ff : 0xff5a5a }));
    mk.position.set(t.x, t.y, t.z);
    resultGroup.add(mk);
  }
  const s = res.stats;
  const saving = s.boxSiliconeVolumeMl > 0 ? (1 - s.siliconeVolumeMl / s.boxSiliconeVolumeMl) * 100 : 0;
  document.getElementById('stats')!.innerHTML = `
    <div class="kpis">
      <div><b>${s.siliconeVolumeMl.toFixed(0)} ml</b><span>silicone needed</span></div>
      <div><b>${saving.toFixed(0)}%</b><span>less than a box mould (${s.boxSiliconeVolumeMl.toFixed(0)} ml)</span></div>
      <div><b>${s.modelVolumeMl.toFixed(0)} ml</b><span>resin per cast</span></div>
      <div><b>${s.shellVolumeCm3.toFixed(0)} cm³</b><span>plastic to print</span></div>
    </div>
    <small>${res.bolts.length} bolt holes · voxel ${s.voxelSize.toFixed(2)} mm · ${(s.millis / 1000).toFixed(1)} s</small>`;
  const vented = res.traps.filter((t) => t.vented).length;
  const blocked = res.traps.filter((t) => !t.vented);
  let html = `<p class="legend"><i style="background:#ffd34d"></i> pour funnel`;
  if (vented) html += ` · <i style="background:#7be0ff"></i> ${vented} air vent${vented > 1 ? 's' : ''} added`;
  html += '</p>';
  if (blocked.length) {
    html += `<div class="warnbox"><b>${blocked.length} air pocket${blocked.length > 1 ? 's' : ''} can't be vented</b> (red):<ul>${[...new Set(blocked.map((b) => b.reason))]
      .map((r) => `<li>${r}</li>`).join('')}</ul>Brush a thin coat of silicone onto those areas first, or rotate the model.</div>`;
  }
  document.getElementById('trapList')!.innerHTML = html;
  document.getElementById('results')!.classList.remove('hidden');
  applyVisibility();
}

const explode = document.getElementById('explode') as HTMLInputElement;
function applyVisibility() {
  if (!result) return;
  const e = parseFloat(explode.value) * 60;
  const dir = result.splitAxis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  parts.halfA?.position.copy(dir.clone().multiplyScalar(-e));
  parts.halfB?.position.copy(dir.clone().multiplyScalar(e));
  parts.base?.position.set(0, 0, -e * 0.5);
  const chk = (id: string) => (document.getElementById(id) as HTMLInputElement).checked;
  if (modelMesh) modelMesh.visible = chk('showModel');
  if (parts.halfA) parts.halfA.visible = chk('showA');
  if (parts.halfB) parts.halfB.visible = chk('showB');
  if (parts.base) parts.base.visible = chk('showBase');
}
explode.oninput = applyVisibility;
for (const id of ['showModel', 'showA', 'showB', 'showBase']) document.getElementById(id)!.onchange = applyVisibility;

// ---------------------------------------------------------------- export
/** Rotates a shell half so its flat split face lies on the print bed (z = 0). */
function orientForPrint(m: Mesh, which: 'halfA' | 'halfB' | 'base', res: MouldResult): Mesh {
  const p = new Float32Array(m.positions);
  const mtx = new THREE.Matrix4();
  if (which !== 'base') {
    // Half A's split face points along +axis, half B's along -axis; turn that normal to -Z.
    const sgn = which === 'halfA' ? 1 : -1;
    if (res.splitAxis === 'x') mtx.makeRotationY((sgn * Math.PI) / 2);
    else mtx.makeRotationX((-sgn * Math.PI) / 2);
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 3) {
    v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(mtx);
    p[i] = v.x; p[i + 1] = v.y; p[i + 2] = v.z;
  }
  const { min, max } = bounds(p);
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= cy; p[i + 2] -= min[2]; }
  return { positions: p, index: m.index };
}

function download(data: ArrayBuffer, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type: 'model/stl' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

document.querySelectorAll<HTMLButtonElement>('[data-dl]').forEach((b) => {
  b.onclick = () => {
    const which = b.dataset.dl!;
    const safe = modelName.replace(/[^\w-]+/g, '_');
    if (which === 'master') {
      if (!tris) return;
      download(writeSTL(tris, Uint32Array.from({ length: tris.length / 3 }, (_, i) => i)), `${safe}_master.stl`);
      return;
    }
    if (!result) return;
    const k = which as 'halfA' | 'halfB' | 'base';
    download(writeSTL(...(Object.values(orientForPrint(result[k], k, result)) as [Float32Array, Uint32Array])), `${safe}_mould_${k}.stl`);
  };
});

// Expose a tiny hook for automated testing.
(window as unknown as { __mould: unknown }).__mould = { get result() { return result; } };
