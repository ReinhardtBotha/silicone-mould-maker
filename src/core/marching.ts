import { edgeTable as ET, triTable as TT } from 'three/examples/jsm/objects/MarchingCubes.js';

// The tables are flat Int32Arrays at runtime (the type declarations disagree).
const edgeTable = ET as unknown as Int32Array;
const triTable = TT as unknown as Int32Array;
import type { Grid } from './grid';

export interface Mesh {
  positions: Float32Array;
  index: Uint32Array;
}

// Cube corner offsets (Paul Bourke ordering) and edge -> corner pairs.
const CORNERS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

/**
 * Extracts the zero level set of `field` (solid where field < 0) as a closed, indexed triangle mesh.
 * Vertices are shared between neighbouring cubes so the result is watertight as long as the
 * field is positive on the grid boundary. Triangles are oriented with outward-facing normals.
 */
export function marchingCubes(field: Float32Array, g: Grid): Mesh {
  const { nx, ny, nz, h, ox, oy, oz } = g;
  const sy = nx, sz = nx * ny;
  const cornerOff = CORNERS.map(([a, b, c]) => a + b * sy + c * sz);
  // Global edge id = sampleIndex * 3 + axis, axis being the direction of the edge.
  const edgeKey = EDGES.map(([p, q]) => {
    const A = CORNERS[p], B = CORNERS[q];
    const lo = [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.min(A[2], B[2])];
    const axis = A[0] !== B[0] ? 0 : A[1] !== B[1] ? 1 : 2;
    return { off: lo[0] + lo[1] * sy + lo[2] * sz, axis };
  });

  const vmap = new Map<number, number>();
  const pos: number[] = [];
  const idx: number[] = [];
  const vals = new Float64Array(8);
  const ev = new Int32Array(12);

  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const q = i + j * sy + k * sz;
        let cube = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[q + cornerOff[c]];
          vals[c] = v;
          if (v < 0) cube |= 1 << c;
        }
        const bits = edgeTable[cube];
        if (bits === 0) continue;
        for (let e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue;
          const key = (q + edgeKey[e].off) * 3 + edgeKey[e].axis;
          let vi = vmap.get(key);
          if (vi === undefined) {
            const [p0, p1] = EDGES[e];
            const a = vals[p0], b = vals[p1];
            let t = a / (a - b);
            if (!isFinite(t)) t = 0.5;
            t = Math.min(1, Math.max(0, t));
            const A = CORNERS[p0], B = CORNERS[p1];
            vi = pos.length / 3;
            pos.push(
              ox + (i + A[0] + (B[0] - A[0]) * t) * h,
              oy + (j + A[1] + (B[1] - A[1]) * t) * h,
              oz + (k + A[2] + (B[2] - A[2]) * t) * h,
            );
            vmap.set(key, vi);
          }
          ev[e] = vi;
        }
        const tb = cube * 16;
        for (let t = 0; triTable[tb + t] !== -1; t += 3) {
          const a = ev[triTable[tb + t]], b = ev[triTable[tb + t + 1]], c = ev[triTable[tb + t + 2]];
          if (a === b || b === c || a === c) continue;
          idx.push(a, b, c);
        }
      }

  const mesh: Mesh = { positions: new Float32Array(pos), index: new Uint32Array(idx) };
  if (signedVolume(mesh) < 0) flip(mesh);
  return mesh;
}

export function signedVolume(m: Mesh): number {
  const p = m.positions, ix = m.index;
  let v = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

function flip(m: Mesh) {
  const ix = m.index;
  for (let t = 0; t < ix.length; t += 3) {
    const tmp = ix[t + 1];
    ix[t + 1] = ix[t + 2];
    ix[t + 2] = tmp;
  }
}

/** Light Taubin smoothing (shrink-free) to take the voxel edge off the surfaces. */
export function taubinSmooth(
  m: Mesh,
  iterations = 4,
  locked?: (x: number, y: number, z: number) => boolean,
  lambda = 0.5,
  mu = -0.53,
) {
  const n = m.positions.length / 3;
  const ix = m.index;
  // Build adjacency in CSR form.
  const deg = new Uint32Array(n);
  for (let t = 0; t < ix.length; t += 3)
    for (let e = 0; e < 3; e++) {
      deg[ix[t + e]] += 2;
    }
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
  const fill = start.slice(0, n);
  const nbr = new Uint32Array(start[n]);
  for (let t = 0; t < ix.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e], b = ix[t + ((e + 1) % 3)], c = ix[t + ((e + 2) % 3)];
      nbr[fill[a]++] = b;
      nbr[fill[a]++] = c;
    }
  const p = m.positions;
  const lock = new Uint8Array(n);
  if (locked) for (let i = 0; i < n; i++) lock[i] = locked(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) ? 1 : 0;
  const tmp = new Float32Array(p.length);
  const step = (f: number) => {
    for (let i = 0; i < n; i++) {
      const s = start[i], e = start[i + 1];
      if (e === s || lock[i]) { tmp[i * 3] = p[i * 3]; tmp[i * 3 + 1] = p[i * 3 + 1]; tmp[i * 3 + 2] = p[i * 3 + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (let q = s; q < e; q++) { const v = nbr[q] * 3; x += p[v]; y += p[v + 1]; z += p[v + 2]; }
      const c = e - s;
      tmp[i * 3] = p[i * 3] + f * (x / c - p[i * 3]);
      tmp[i * 3 + 1] = p[i * 3 + 1] + f * (y / c - p[i * 3 + 1]);
      tmp[i * 3 + 2] = p[i * 3 + 2] + f * (z / c - p[i * 3 + 2]);
    }
    p.set(tmp);
  };
  for (let it = 0; it < iterations; it++) {
    step(lambda);
    step(mu);
  }
}
