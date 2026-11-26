import { edt3 } from './edt';
import { Grid, voxelize } from './grid';
import { Mesh, marchingCubes, signedVolume, taubinSmooth } from './marching';

export interface MouldParams {
  /** Silicone layer thickness between the master and the shell (mm). */
  siliconeThickness: number;
  /** Printed shell wall thickness (mm). */
  wallThickness: number;
  /** Bridges concave gaps smaller than ~2x this radius so the shell is simpler (mm). 0 = follow every detail. */
  smoothing: number;
  splitAxis: 'x' | 'y';
  /** Offset of the split plane from the model centre along the split axis (mm). */
  splitOffset: number;
  flangeWidth: number;
  flangeThickness: number;
  /** How the two halves are aligned / fastened. Pins = blind sockets in both halves + loose pins, clamp externally. */
  joints: 'pins' | 'bolts' | 'none';
  boltDiameter: number;
  pinDiameter: number;
  /** Depth of each pin socket (per half), limited to flange thickness - 0.8 mm. */
  pinDepth: number;
  /** Extra radius added to the sockets so pins slide in. */
  pinClearance: number;
  jointSpacing: number;
  pourDiameter: number;
  funnelHeight: number;
  vents: boolean;
  ventDiameter: number;
  /** Ignore air pockets shallower than this (mm). */
  ventMinPocket: number;
  baseThickness: number;
  baseMargin: number;
  baseRidge: boolean;
  /** Grid cells along the longest side of the working volume. */
  resolution: number;
}

export const defaultParams: MouldParams = {
  siliconeThickness: 5,
  wallThickness: 2.4,
  smoothing: 6,
  splitAxis: 'x',
  splitOffset: 0,
  flangeWidth: 10,
  flangeThickness: 4,
  joints: 'pins',
  boltDiameter: 3.4,
  pinDiameter: 4,
  pinDepth: 3,
  pinClearance: 0.15,
  jointSpacing: 35,
  pourDiameter: 12,
  funnelHeight: 12,
  vents: true,
  ventDiameter: 3,
  ventMinPocket: 1.5,
  baseThickness: 3,
  baseMargin: 4,
  baseRidge: true,
  resolution: 170,
};

export interface Point3 { x: number; y: number; z: number }
export interface Trap extends Point3 { depth: number; vented: boolean; reason?: string }

export interface MouldResult {
  halfA: Mesh;
  halfB: Mesh;
  base: Mesh;
  pour: Point3;
  traps: Trap[];
  /** Bolt hole or pin socket centres on the split plane. */
  joints: Point3[];
  jointType: MouldParams['joints'];
  /** Loose alignment pins to print (only for joints = 'pins'). */
  pins: Mesh | null;
  splitAxis: 'x' | 'y';
  splitPos: number;
  z0: number;
  stats: {
    voxelSize: number;
    gridCells: number;
    modelVolumeMl: number;
    siliconeVolumeMl: number;
    boxSiliconeVolumeMl: number;
    shellVolumeCm3: number;
    millis: number;
  };
}

type Progress = (stage: string, fraction: number) => void;

export function generateMould(tris: Float32Array, P: MouldParams, progress: Progress = () => {}): MouldResult {
  const t0 = performance.now();
  if (tris.length < 9) throw new Error('The model has no triangles.');

  // ---- bounds & grid ---------------------------------------------------------------------------
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const g = P.siliconeThickness, w = P.wallThickness, R = Math.max(0, P.smoothing);
  const fw = P.flangeWidth, ft = P.flangeThickness;
  const z0 = minZ;

  const lateral = Math.max(g + w + fw + P.baseMargin + 1, g + R + w + 1);
  const top = Math.max(g + w + P.funnelHeight + w * 2 + 2, g + R + w + 1);
  const bottom = Math.max(P.baseThickness + 1, g + R + 1);
  const ext = Math.max(maxX - minX + 2 * lateral, maxY - minY + 2 * lateral, maxZ - minZ + top + bottom);
  const h = Math.max(0.25, ext / P.resolution);
  const pad = 3 * h;
  // Tiny irrational jitter keeps grid rays from hitting mesh vertices of axis-aligned models exactly.
  const grid: Grid = {
    h,
    ox: minX - lateral - pad + h * 0.0137,
    oy: minY - lateral - pad + h * 0.0291,
    oz: minZ - bottom - pad + h * 0.0419,
    nx: 0, ny: 0, nz: 0,
  };
  grid.nx = Math.ceil((maxX + lateral + pad - grid.ox) / h) + 1;
  grid.ny = Math.ceil((maxY + lateral + pad - grid.oy) / h) + 1;
  grid.nz = Math.ceil((maxZ + top + pad - grid.oz) / h) + 1;
  const { nx, ny, nz, ox, oy, oz } = grid;
  const N = nx * ny * nz, sy = nx, sz = nx * ny;
  const kz0 = Math.max(0, Math.ceil((z0 - oz) / h));

  // ---- master classification & distance fields ------------------------------------------------
  progress('Voxelising model', 0.05);
  const inside = voxelize(tris, grid);

  progress('Distance field', 0.15);
  const phi = edt3(inside, nx, ny, nz); // squared voxel distances -> converted in place below
  for (let i = 0; i < N; i++) phi[i] = inside[i] ? 0 : Math.max(0, Math.sqrt(phi[i]) - 0.5) * h;

  // phi := signed offset distance of the silicone cavity boundary (cavity where phi <= 0).
  if (R > 0) {
    progress('Smoothing shell shape', 0.25);
    const outer = new Uint8Array(N);
    const lim = g + R;
    for (let i = 0; i < N; i++) outer[i] = phi[i] > lim ? 1 : 0;
    const E = edt3(outer, nx, ny, nz);
    for (let i = 0; i < N; i++) {
      const D = phi[i];
      phi[i] = D <= lim ? R - Math.max(0, Math.sqrt(E[i]) - 0.5) * h : D - g;
    }
  } else {
    for (let i = 0; i < N; i++) phi[i] -= g;
  }

  // Light separable [1 2 1] blur removes the voxel stair-stepping of the distance transform.
  progress('Smoothing distance field', 0.3);
  blur3(phi, nx, ny, nz, 2);

  // ---- split plane ------------------------------------------------------------------------------
  const sAxis = P.splitAxis === 'x' ? 0 : 1;
  const sp = (sAxis === 0 ? (minX + maxX) / 2 : (minY + maxY) / 2) + P.splitOffset;
  const inFlangeZone = (x: number, y: number) => Math.abs((sAxis === 0 ? x : y) - sp) <= ft;
  const bodySolidAt = (id: number, x: number, y: number) => {
    const f = phi[id];
    return f >= 0 && (f <= w || (inFlangeZone(x, y) && f <= w + fw));
  };

  // ---- cavity analysis: volume + air traps (merge tree over height) ----------------------------
  progress('Analysing air traps', 0.35);
  const cav = new Uint8Array(N);
  let cavCount = 0, modelCount = 0;
  for (let k = kz0; k < nz; k++)
    for (let q = k * sz, e = q + sz; q < e; q++) {
      if (inside[q]) modelCount++;
      else if (phi[q] <= 0) { cav[q] = 1; cavCount++; }
    }

  const parent = new Int32Array(N).fill(-1);
  const slotOf = new Int32Array(N).fill(-1);
  const birthK: number[] = [], birthId: number[] = [], sumI: number[] = [], sumJ: number[] = [], cnt: number[] = [];
  const deaths: { slot: number; depth: number }[] = [];
  const find = (a: number) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const n = parent[a]; parent[a] = r; a = n; }
    return r;
  };
  const merge = (ra: number, rb: number, k: number) => {
    if (ra === rb) return ra;
    const a = slotOf[ra], b = slotOf[rb];
    const aElder = birthK[a] > birthK[b] || (birthK[a] === birthK[b] && cnt[a] >= cnt[b]);
    const [er, yr, es, ys] = aElder ? [ra, rb, a, b] : [rb, ra, b, a];
    if (birthK[es] === k && birthK[ys] === k) { sumI[es] += sumI[ys]; sumJ[es] += sumJ[ys]; cnt[es] += cnt[ys]; }
    else deaths.push({ slot: ys, depth: (birthK[ys] - k) * h });
    parent[yr] = er;
    return er;
  };
  for (let k = nz - 2; k >= kz0; k--)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const id = i + j * sy + k * sz;
        if (!cav[id]) continue;
        let root = -1;
        for (const nb of [id + sz, id - 1, id - sy]) {
          if (!cav[nb] || parent[nb] < 0) continue;
          const r = find(nb);
          root = root < 0 ? r : merge(root, r, k);
        }
        if (root < 0) {
          parent[id] = id;
          slotOf[id] = birthK.length;
          birthK.push(k); birthId.push(id); sumI.push(i); sumJ.push(j); cnt.push(1);
        } else {
          parent[id] = root;
          const s = slotOf[root];
          if (birthK[s] === k) { sumI[s] += i; sumJ[s] += j; cnt[s]++; }
        }
      }
  const survivors = new Set<number>();
  for (let id = 0; id < N; id++) if (cav[id] && parent[id] >= 0) survivors.add(slotOf[find(id)]);
  if (survivors.size === 0) throw new Error('Could not find the silicone cavity — is the model closed (watertight) and in millimetres?');
  let mainSlot = -1;
  for (const s of survivors) if (mainSlot < 0 || birthK[s] > birthK[mainSlot] || (birthK[s] === birthK[mainSlot] && cnt[s] > cnt[mainSlot])) mainSlot = s;

  const peakOf = (slot: number) => {
    const k = birthK[slot];
    let i = Math.round(sumI[slot] / cnt[slot]), j = Math.round(sumJ[slot] / cnt[slot]);
    if (!cav[i + j * sy + k * sz]) {
      const id = birthId[slot];
      i = id % nx; j = Math.floor(id / nx) % ny;
    }
    return { i, j, k };
  };

  // Walk up a column from a cavity peak through the shell. Returns the z where it exits, or null if blocked by the master.
  const exitAbove = (i: number, j: number, k: number): { zExit: number } | { blocked: string } => {
    const x = ox + i * h, y = oy + j * h;
    let kk = k + 1;
    while (kk < nz && cav[i + j * sy + kk * sz]) kk++;
    if (kk >= nz) return { blocked: 'open' };
    if (inside[i + j * sy + kk * sz]) return { blocked: 'Pocket sits under an overhang of the model — tilt the model so this area points up.' };
    while (kk < nz && bodySolidAt(i + j * sy + kk * sz, x, y)) kk++;
    return { zExit: oz + kk * h };
  };

  const mp = peakOf(mainSlot);
  const pour = { x: ox + mp.i * h, y: oy + mp.j * h, z: oz + mp.k * h };
  const pourExit = exitAbove(mp.i, mp.j, mp.k);
  const zOut = 'zExit' in pourExit ? pourExit.zExit : pour.z + w;

  const traps: Trap[] = [];
  const pocketSlots = deaths.filter((d) => d.depth >= P.ventMinPocket);
  for (const s of survivors) if (s !== mainSlot) pocketSlots.push({ slot: s, depth: Infinity });
  for (const { slot, depth } of pocketSlots) {
    const p = peakOf(slot);
    const t: Trap = { x: ox + p.i * h, y: oy + p.j * h, z: oz + p.k * h, depth, vented: false };
    const r = exitAbove(p.i, p.j, p.k);
    if ('zExit' in r) {
      t.vented = P.vents;
      if (!P.vents) t.reason = 'Vents disabled.';
      (t as Trap & { zExit: number }).zExit = r.zExit;
    } else t.reason = r.blocked;
    // Skip pockets right next to the pour hole — the funnel already vents them.
    if (Math.hypot(t.x - pour.x, t.y - pour.y) < P.pourDiameter / 2 + w) continue;
    traps.push(t);
  }
  const vents = traps.filter((t) => t.vented) as (Trap & { zExit: number })[];
  const rv0 = P.ventDiameter / 2;

  // ---- bolt / pin positions along the flange ------------------------------------------------------
  progress(P.joints === 'pins' ? 'Placing alignment pins' : 'Placing bolts', 0.45);
  const bolts: Point3[] = [];
  const usePins = P.joints === 'pins';
  const rb = P.boltDiameter / 2;
  const pinDepth = Math.max(0.5, Math.min(P.pinDepth, ft - 0.8));
  const rs = P.pinDiameter / 2 + P.pinClearance; // socket radius
  const rj = usePins ? rs : rb; // hole radius used for placement
  const sample = (x: number, y: number, z: number) => {
    const i = Math.round((x - ox) / h), j = Math.round((y - oy) / h), k = Math.round((z - oz) / h);
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 1e9;
    return phi[i + j * sy + k * sz];
  };
  const ridgeH = P.baseRidge ? 3 : 0;
  if (P.joints !== 'none' && fw >= 2 * rj + 2) {
    const target = w + fw / 2;
    const cands: { t: number; z: number }[] = [];
    const si = Math.round(((sAxis === 0 ? 0 : 0) + sp - (sAxis === 0 ? ox : oy)) / h);
    const nT = sAxis === 0 ? ny : nx;
    for (let k = kz0; k < nz; k++)
      for (let tI = 0; tI < nT; tI++) {
        const id = sAxis === 0 ? si + tI * sy + k * sz : tI + si * sy + k * sz;
        if (Math.abs(phi[id] - target) > 0.75 * h) continue;
        const t = (sAxis === 0 ? oy : ox) + tI * h, z = oz + k * h;
        if (z < z0 + ridgeH + rj + 2.5) continue;
        cands.push({ t, z });
      }
    cands.sort((a, b) => a.z - b.z);
    const headR = rb * 1.9;
    const spacing = Math.max(P.jointSpacing, rj * 6);
    const pt = sAxis === 0 ? pour.y : pour.x;
    const ps = sAxis === 0 ? pour.x : pour.y;
    for (const c of cands) {
      if (bolts.some((b) => Math.hypot((sAxis === 0 ? b.y : b.x) - c.t, b.z - c.z) < spacing)) continue;
      if (Math.abs(ps - sp) < P.pourDiameter / 2 + w * 2 + rj && Math.abs(c.t - pt) < P.pourDiameter / 2 + w * 2 + rj + 2 && c.z > pour.z - 3) continue;
      // Keep pin sockets clear of vent holes running through the flange.
      if (vents.some((v) => Math.hypot(v.x - (sAxis === 0 ? sp : c.t), v.y - (sAxis === 0 ? c.t : sp)) < rj + rv0 + 1 && c.z > v.z - rj - 1 && c.z < v.zExit + rj + 1)) continue;
      // Bolts need room for a head / nut on both sides (no shell wall in the way).
      let ok = true;
      if (!usePins) for (const side of [-1, 1])
        for (const d of [ft + 0.6, ft + 4])
          for (const [dt, dz] of [[0, 0], [headR, 0], [-headR, 0], [0, headR], [0, -headR]]) {
            const s = sp + side * d, t = c.t + dt, z = c.z + dz;
            const f = sAxis === 0 ? sample(s, t, z) : sample(t, s, z);
            if (f <= w + 0.3 || z < z0) ok = false;
          }
      if (!ok) continue;
      bolts.push(sAxis === 0 ? { x: sp, y: c.t, z: c.z } : { x: c.t, y: sp, z: c.z });
    }
  }

  // ---- shell halves ---------------------------------------------------------------------------
  const field = new Float32Array(N);
  const rp = P.pourDiameter / 2, rv = P.ventDiameter / 2, H = P.funnelHeight;

  const buildHalf = (side: -1 | 1) => {
    for (let k = 0; k < nz; k++) {
      const z = oz + k * h;
      for (let j = 0; j < ny; j++) {
        const y = oy + j * h;
        for (let i = 0; i < nx; i++) {
          const x = ox + i * h;
          const id = i + j * sy + k * sz;
          if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) { field[id] = 1; continue; }
          const f0 = phi[id];
          const s = sAxis === 0 ? x : y, t = sAxis === 0 ? y : x;
          const ds = s - sp;
          let f = Math.max(-f0, f0 - w);
          f = Math.min(f, Math.max(Math.abs(ds) - ft, -f0, f0 - (w + fw)));
          f = Math.max(f, z0 - z);
          // funnel
          const rho = Math.hypot(x - pour.x, y - pour.y);
          const rIn = rp + Math.max(0, z - zOut);
          if (H > 0) {
            const thick = z > zOut ? w * 1.42 : w;
            f = Math.min(f, Math.max(rIn - rho, rho - rIn - thick, pour.z - z, z - (zOut + H)));
          }
          f = Math.max(f, -Math.max(rho - rIn, pour.z - h * 0.5 - z));
          // vents
          for (const v of vents) {
            const r = Math.hypot(x - v.x, y - v.y);
            if (r > rv + 2 * h) continue;
            f = Math.max(f, -Math.max(r - rv, v.z - h - z, z - (v.zExit + h)));
          }
          // bolt holes straight through both flanges, or blind pin sockets with a small lead-in chamfer
          for (const b of bolts) {
            const r = Math.hypot(t - (sAxis === 0 ? b.y : b.x), z - b.z);
            if (r > rj + 1 + 2 * h) continue;
            const ad = Math.abs(ds);
            f = usePins
              ? Math.max(f, -Math.max(r - rs - Math.max(0, 0.5 - ad), ad - pinDepth))
              : Math.max(f, -Math.max(r - rb, ad - ft - h));
          }
          // keep one side of the split plane
          f = Math.max(f, side < 0 ? ds : -ds);
          field[id] = f;
        }
      }
    }
    const m = marchingCubes(field, grid);
    const eps = h * 0.02;
    taubinSmooth(m, 3, (x, y, z) => Math.abs((sAxis === 0 ? x : y) - sp) < eps || Math.abs(z - z0) < eps);
    return m;
  };

  progress('Building shell half A', 0.5);
  const halfA = buildHalf(-1);
  progress('Building shell half B', 0.68);
  const halfB = buildHalf(1);

  // ---- base plate ------------------------------------------------------------------------------
  progress('Building base plate', 0.85);
  const kb = Math.min(nz - 1, kz0 + 1);
  const clr = 0.3, rw = 1.6;
  // Shallow pocket matching the master's footprint so it can be located and glued down accurately.
  const pocketDepth = Math.min(1, P.baseThickness * 0.4);
  const fp = new Uint8Array(nx * ny), nfp = new Uint8Array(nx * ny);
  for (let q = 0; q < nx * ny; q++) { fp[q] = inside[q + kb * sz]; nfp[q] = fp[q] ? 0 : 1; }
  const dOut = edt3(fp, nx, ny, 1), dIn = edt3(nfp, nx, ny, 1);
  const foot = new Float32Array(nx * ny);
  for (let q = 0; q < nx * ny; q++)
    foot[q] = fp[q] ? -Math.max(0, Math.sqrt(dIn[q]) - 0.5) * h : Math.max(0, Math.sqrt(dOut[q]) - 0.5) * h;
  for (let k = 0; k < nz; k++) {
    const z = oz + k * h;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const id = i + j * sy + k * sz;
        if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) { field[id] = 1; continue; }
        const x = ox + i * h, y = oy + j * h;
        const f2 = phi[i + j * sy + kb * sz];
        let f = Math.max(z - z0, z0 - P.baseThickness - z, f2 - (w + fw + P.baseMargin));
        if (P.baseRidge) {
          const ds = Math.abs((sAxis === 0 ? x : y) - sp);
          f = Math.min(f, Math.max(z0 - z - h, z - (z0 + ridgeH), w + clr - f2, f2 - (w + clr + rw), ft + clr + 0.5 - ds));
        }
        f = Math.max(f, -Math.max(foot[i + j * sy] - 0.2, z0 - pocketDepth - z));
        field[id] = f;
      }
  }
  const base = marchingCubes(field, grid);
  taubinSmooth(base, 2, (_x, _y, z) => Math.abs(z - z0) < h * 0.02 || Math.abs(z - (z0 - P.baseThickness)) < h * 0.02 || Math.abs(z - (z0 - pocketDepth)) < h * 0.02);

  // ---- stats ------------------------------------------------------------------------------------
  const vox = h * h * h;
  const modelVol = modelCount * vox;
  const bw = maxX - minX + 2 * g, bd = maxY - minY + 2 * g, bh = maxZ - minZ + g;
  progress('Done', 1);
  return {
    halfA, halfB, base, pour, traps,
    joints: bolts,
    jointType: P.joints,
    pins: usePins && bolts.length ? makePins(bolts.length, P.pinDiameter, 2 * pinDepth - 0.4) : null,
    splitAxis: P.splitAxis, splitPos: sp, z0,
    stats: {
      voxelSize: h,
      gridCells: N,
      modelVolumeMl: modelVol / 1000,
      siliconeVolumeMl: (cavCount * vox) / 1000,
      boxSiliconeVolumeMl: Math.max(0, bw * bd * bh - modelVol) / 1000,
      shellVolumeCm3: (signedVolume(halfA) + signedVolume(halfB) + signedVolume(base)) / 1000,
      millis: performance.now() - t0,
    },
  };
}

function blur3(f: Float32Array, nx: number, ny: number, nz: number, passes: number) {
  const n = Math.max(nx, ny, nz);
  const line = new Float32Array(n);
  const run = (count: number, stride: number, starts: Iterable<number>) => {
    for (const s0 of starts) {
      for (let q = 0; q < count; q++) line[q] = f[s0 + q * stride];
      for (let q = 1; q < count - 1; q++) f[s0 + q * stride] = 0.25 * line[q - 1] + 0.5 * line[q] + 0.25 * line[q + 1];
    }
  };
  function* xs() { for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) yield nx * (j + ny * k); }
  function* ys() { for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) yield i + nx * ny * k; }
  function* zs() { for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) yield i + nx * j; }
  for (let p = 0; p < passes; p++) {
    run(nx, 1, xs());
    run(ny, nx, ys());
    run(nz, nx * ny, zs());
  }
}

/** Row of chamfered cylindrical pins standing upright, ready to print. */
function makePins(count: number, diameter: number, length: number): Mesh {
  const r = diameter / 2, ch = Math.min(0.4, r * 0.3, length / 4), seg = 32;
  // Profile (radius, z) from bottom to top including chamfers.
  const prof: [number, number][] = [[r - ch, 0], [r, ch], [r, length - ch], [r - ch, length]];
  const pos: number[] = [], idx: number[] = [];
  const pitch = diameter + 3;
  const cols = Math.ceil(Math.sqrt(count));
  for (let n = 0; n < count; n++) {
    const cx = (n % cols) * pitch, cy = Math.floor(n / cols) * pitch;
    const base = pos.length / 3;
    for (const [pr, pz] of prof)
      for (let a = 0; a < seg; a++) {
        const th = (a / seg) * Math.PI * 2;
        pos.push(cx + pr * Math.cos(th), cy + pr * Math.sin(th), pz);
      }
    const bottomC = pos.length / 3; pos.push(cx, cy, 0);
    const topC = pos.length / 3; pos.push(cx, cy, length);
    for (let ring = 0; ring < prof.length - 1; ring++)
      for (let a = 0; a < seg; a++) {
        const a1 = (a + 1) % seg;
        const p00 = base + ring * seg + a, p01 = base + ring * seg + a1;
        const p10 = base + (ring + 1) * seg + a, p11 = base + (ring + 1) * seg + a1;
        idx.push(p00, p01, p11, p00, p11, p10);
      }
    const last = base + (prof.length - 1) * seg;
    for (let a = 0; a < seg; a++) {
      const a1 = (a + 1) % seg;
      idx.push(bottomC, base + a1, base + a);
      idx.push(topC, last + a, last + a1);
    }
  }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx) };
}
