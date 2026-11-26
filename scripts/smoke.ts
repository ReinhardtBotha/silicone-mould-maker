// Node smoke test: builds the demo teddy, generates a mould, checks meshes are closed & manifold, writes STLs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { makeTeddy } from '../src/core/teddy';
import { defaultParams, generateMould } from '../src/core/mould';
import { writeSTL } from '../src/core/stl';
import type { Mesh } from '../src/core/marching';

function checkClosed(name: string, m: Mesh) {
  const edges = new Map<string, number>();
  const ix = m.index;
  for (let t = 0; t < ix.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e], b = ix[t + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  let open = 0, nonManifold = 0;
  for (const c of edges.values()) { if (c === 1) open++; else if (c > 2) nonManifold++; }
  console.log(`${name}: ${ix.length / 3} tris, open edges ${open}, non-manifold edges ${nonManifold}`);
  return open === 0;
}

const teddy = makeTeddy();
console.log('teddy tris', teddy.length / 9);
const res = generateMould(teddy, { ...defaultParams, resolution: Number(process.argv[2] ?? 140) }, (s, f) =>
  console.log(`  ${(f * 100).toFixed(0)}% ${s}`),
);
console.log(JSON.stringify({ stats: res.stats, pour: res.pour, traps: res.traps, joints: res.joints.length, jointType: res.jointType }, null, 1));
let ok = true;
ok = checkClosed('halfA', res.halfA) && ok;
ok = checkClosed('halfB', res.halfB) && ok;
ok = checkClosed('base', res.base) && ok;
if (res.pins) ok = checkClosed('pins', res.pins) && ok;
mkdirSync(process.argv[3] ?? 'out', { recursive: true });
const dir = process.argv[3] ?? 'out';
for (const [n, m] of [['halfA', res.halfA], ['halfB', res.halfB], ['base', res.base]] as const)
  writeFileSync(`${dir}/${n}.stl`, Buffer.from(writeSTL(m.positions, m.index)));
writeFileSync(`${dir}/teddy.stl`, Buffer.from(writeSTL(teddy, Uint32Array.from({ length: teddy.length / 3 }, (_, i) => i))));
process.exit(ok ? 0 : 1);
