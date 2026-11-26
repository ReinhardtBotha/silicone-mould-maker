/** Regular sample grid. Sample (i,j,k) sits at origin + (i,j,k) * h. */
export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  h: number;
  ox: number;
  oy: number;
  oz: number;
}

export const gridIndex = (g: Grid, i: number, j: number, k: number) => i + g.nx * (j + g.ny * k);

/**
 * Inside/outside classification of the grid samples for a triangle soup.
 * Casts parity rays along all three axes and takes a majority vote, which makes
 * the result tolerant of small holes / non-manifold bits in real-world STLs.
 */
export function voxelize(tris: Float32Array, g: Grid): Uint8Array {
  const N = g.nx * g.ny * g.nz;
  const votes = new Uint8Array(N);
  const dims = [g.nx, g.ny, g.nz];
  const orig = [g.ox, g.oy, g.oz];
  const strides = [1, g.nx, g.nx * g.ny];
  const h = g.h;
  const triCount = tris.length / 9;

  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, c = (a + 2) % 3;
    const nb = dims[b], nc = dims[c];
    const cols: (number[] | undefined)[] = new Array(nb * nc);
    for (let t = 0; t < triCount; t++) {
      const o = t * 9;
      const A0 = tris[o + a], B0 = tris[o + b], C0 = tris[o + c];
      const A1 = tris[o + 3 + a], B1 = tris[o + 3 + b], C1 = tris[o + 3 + c];
      const A2 = tris[o + 6 + a], B2 = tris[o + 6 + b], C2 = tris[o + 6 + c];
      const det = (B1 - B0) * (C2 - C0) - (B2 - B0) * (C1 - C0);
      if (Math.abs(det) < 1e-14) continue;
      const ib0 = Math.max(0, Math.ceil((Math.min(B0, B1, B2) - orig[b]) / h));
      const ib1 = Math.min(nb - 1, Math.floor((Math.max(B0, B1, B2) - orig[b]) / h));
      const ic0 = Math.max(0, Math.ceil((Math.min(C0, C1, C2) - orig[c]) / h));
      const ic1 = Math.min(nc - 1, Math.floor((Math.max(C0, C1, C2) - orig[c]) / h));
      for (let ic = ic0; ic <= ic1; ic++) {
        const pc = orig[c] + ic * h;
        for (let ib = ib0; ib <= ib1; ib++) {
          const pb = orig[b] + ib * h;
          const w1 = ((pb - B0) * (C2 - C0) - (B2 - B0) * (pc - C0)) / det;
          const w2 = ((B1 - B0) * (pc - C0) - (pb - B0) * (C1 - C0)) / det;
          const w0 = 1 - w1 - w2;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const pa = A0 * w0 + A1 * w1 + A2 * w2;
          const key = ib + nb * ic;
          (cols[key] ??= []).push(pa);
        }
      }
    }
    for (let ic = 0; ic < nc; ic++)
      for (let ib = 0; ib < nb; ib++) {
        const list = cols[ib + nb * ic];
        if (!list || list.length < 2) continue;
        list.sort((x, y) => x - y);
        const base = ib * strides[b] + ic * strides[c];
        for (let m = 0; m + 1 < list.length; m += 2) {
          const i0 = Math.max(0, Math.ceil((list[m] - orig[a]) / h));
          const i1 = Math.min(dims[a] - 1, Math.floor((list[m + 1] - orig[a]) / h));
          for (let ia = i0; ia <= i1; ia++) votes[base + ia * strides[a]]++;
        }
      }
  }
  const inside = new Uint8Array(N);
  for (let i = 0; i < N; i++) inside[i] = votes[i] >= 2 ? 1 : 0;
  return inside;
}
