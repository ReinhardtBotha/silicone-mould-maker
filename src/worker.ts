import { generateMould, MouldParams } from './core/mould';
import { makeTeddy } from './core/teddy';

export type WorkerRequest =
  | { type: 'generate'; tris: Float32Array; params: MouldParams }
  | { type: 'demo' };

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'demo') {
      const tris = makeTeddy();
      (self as unknown as Worker).postMessage({ type: 'demo', tris }, [tris.buffer]);
      return;
    }
    const res = generateMould(msg.tris, msg.params, (stage, fraction) =>
      (self as unknown as Worker).postMessage({ type: 'progress', stage, fraction }),
    );
    const transfer = [res.halfA, res.halfB, res.base].flatMap((m) => [m.positions.buffer, m.index.buffer]);
    (self as unknown as Worker).postMessage({ type: 'result', result: res }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
