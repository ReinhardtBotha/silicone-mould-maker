/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher) on a 3D grid.
 * Returns squared distances, in voxel units, from every voxel to the nearest voxel where feature[i] !== 0.
 */
const INF = 1e20;

export function edt3(feature: Uint8Array, nx: number, ny: number, nz: number): Float32Array {
  const out = new Float32Array(nx * ny * nz);
  for (let i = 0; i < out.length; i++) out[i] = feature[i] ? 0 : INF;
  const maxN = Math.max(nx, ny, nz);
  const f = new Float64Array(maxN);
  const d = new Float64Array(maxN);
  const v = new Int32Array(maxN);
  const z = new Float64Array(maxN + 1);

  // x pass
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++) {
      const base = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) f[i] = out[base + i];
      dt(f, nx, d, v, z);
      for (let i = 0; i < nx; i++) out[base + i] = d[i];
    }
  // y pass
  for (let k = 0; k < nz; k++)
    for (let i = 0; i < nx; i++) {
      const base = i + nx * ny * k;
      for (let j = 0; j < ny; j++) f[j] = out[base + j * nx];
      dt(f, ny, d, v, z);
      for (let j = 0; j < ny; j++) out[base + j * nx] = d[j];
    }
  // z pass
  const sz = nx * ny;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const base = i + nx * j;
      for (let k = 0; k < nz; k++) f[k] = out[base + k * sz];
      dt(f, nz, d, v, z);
      for (let k = 0; k < nz; k++) out[base + k * sz] = d[k];
    }
  return out;
}

function dt(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = 0;
    for (;;) {
      const r = v[k];
      s = (f[q] + q * q - (f[r] + r * r)) / (2 * q - 2 * r);
      if (s <= z[k] && k > 0) k--;
      else break;
    }
    if (s <= z[k]) {
      // k === 0 and the new parabola dominates everywhere
      v[0] = q;
      z[0] = -INF;
      z[1] = INF;
      continue;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    d[q] = (q - r) * (q - r) + f[r];
  }
}
