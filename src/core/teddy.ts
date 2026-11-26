import type { Grid } from './grid';
import { marchingCubes, taubinSmooth } from './marching';

/** Builds a simple procedural teddy bear (~75 mm tall) as a triangle soup, used as a demo model. */
export function makeTeddy(): Float32Array {
  type Prim = (x: number, y: number, z: number) => number;
  const sphere = (cx: number, cy: number, cz: number, r: number): Prim => (x, y, z) => Math.hypot(x - cx, y - cy, z - cz) - r;
  const ellipsoid = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): Prim => (x, y, z) => {
    const k0 = Math.hypot((x - cx) / rx, (y - cy) / ry, (z - cz) / rz);
    const k1 = Math.hypot((x - cx) / (rx * rx), (y - cy) / (ry * ry), (z - cz) / (rz * rz));
    return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
  };
  const capsule = (a: number[], b: number[], r: number): Prim => (x, y, z) => {
    const pa = [x - a[0], y - a[1], z - a[2]], ba = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const t = Math.max(0, Math.min(1, (pa[0] * ba[0] + pa[1] * ba[1] + pa[2] * ba[2]) / (ba[0] ** 2 + ba[1] ** 2 + ba[2] ** 2)));
    return Math.hypot(pa[0] - ba[0] * t, pa[1] - ba[1] * t, pa[2] - ba[2] * t) - r;
  };
  const smin = (a: number, b: number, k: number) => {
    const hh = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - (hh * hh * k) / 4;
  };
  const parts: [Prim, number][] = [
    [ellipsoid(0, 0, 24, 17, 14, 20), 0],
    [sphere(0, -1, 52, 14), 4],
    [ellipsoid(0, -12, 49, 6.5, 5, 5), 3], // muzzle
    [sphere(-11, 0, 63, 5.5), 2.5], // ears
    [sphere(11, 0, 63, 5.5), 2.5],
    [capsule([-14, -2, 32], [-21, -10, 18], 5.5), 4], // arms
    [capsule([14, -2, 32], [21, -10, 18], 5.5), 4],
    [capsule([-9, -4, 9], [-10, -14, 6], 7), 4], // legs
    [capsule([9, -4, 9], [10, -14, 6], 7), 4],
  ];
  const sdf = (x: number, y: number, z: number) => {
    let d = 1e9;
    for (const [p, k] of parts) d = k > 0 ? smin(d, p(x, y, z), k) : Math.min(d, p(x, y, z));
    // Flat bottom so it can sit on the base plate.
    return Math.max(d, -z);
  };
  const h = 0.7;
  const g: Grid = { h, ox: -34, oy: -28, oz: -2, nx: 0, ny: 0, nz: 0 };
  g.nx = Math.ceil(68 / h); g.ny = Math.ceil(50 / h); g.nz = Math.ceil(74 / h);
  const field = new Float32Array(g.nx * g.ny * g.nz);
  for (let k = 0; k < g.nz; k++)
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) field[i + g.nx * (j + g.ny * k)] = sdf(g.ox + i * h, g.oy + j * h, g.oz + k * h);
  const m = marchingCubes(field, g);
  taubinSmooth(m, 3, (_x, _y, z) => Math.abs(z) < 0.01);
  const out = new Float32Array(m.index.length * 3);
  for (let t = 0; t < m.index.length; t++) {
    const v = m.index[t] * 3;
    out[t * 3] = m.positions[v]; out[t * 3 + 1] = m.positions[v + 1]; out[t * 3 + 2] = m.positions[v + 2];
  }
  return out;
}
