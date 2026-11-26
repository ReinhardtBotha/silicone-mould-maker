/** Minimal STL reader / writer (binary + ASCII). Triangles are flat Float32Arrays, 9 floats per triangle. */

export function parseSTL(buffer: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(buffer);
  if (bytes.length >= 84) {
    const view = new DataView(buffer);
    const count = view.getUint32(80, true);
    if (84 + count * 50 === bytes.length) return parseBinary(view, count);
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart();
  if (head.startsWith('solid') && /facet|endsolid/.test(new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096))))) {
    return parseASCII(new TextDecoder().decode(bytes));
  }
  // Fall back to binary even if the size header is slightly off (some exporters pad the file).
  const view = new DataView(buffer);
  const count = Math.floor((bytes.length - 84) / 50);
  return parseBinary(view, count);
}

function parseBinary(view: DataView, count: number): Float32Array {
  const out = new Float32Array(count * 9);
  let o = 84;
  for (let t = 0; t < count; t++) {
    o += 12; // skip normal
    for (let k = 0; k < 9; k++) {
      out[t * 9 + k] = view.getFloat32(o, true);
      o += 4;
    }
    o += 2;
  }
  return out;
}

function parseASCII(text: string): Float32Array {
  const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
  const vals: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  const n = Math.floor(vals.length / 9) * 9;
  return new Float32Array(vals.slice(0, n));
}

/** Writes a binary STL from an indexed mesh. */
export function writeSTL(positions: Float32Array, index: Uint32Array): ArrayBuffer {
  const triCount = index.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buf);
  const header = 'silicone-mould-maker';
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triCount, true);
  let o = 84;
  for (let t = 0; t < triCount; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    view.setFloat32(o, nx, true); view.setFloat32(o + 4, ny, true); view.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      view.setFloat32(o, positions[v], true);
      view.setFloat32(o + 4, positions[v + 1], true);
      view.setFloat32(o + 8, positions[v + 2], true);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

/** Converts a triangle soup to an indexed mesh (no welding, used only for display / export of the master). */
export function soupToIndexed(tris: Float32Array): { positions: Float32Array; index: Uint32Array } {
  const n = tris.length / 3;
  const index = new Uint32Array(n);
  for (let i = 0; i < n; i++) index[i] = i;
  return { positions: tris, index };
}
