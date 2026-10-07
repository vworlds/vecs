/** A function returning a uniformly distributed number in `[0, 1)`. */
export type Random = () => number;

/**
 * A seeded generator (mulberry32). The same seed always yields the same
 * sequence, which is what makes a lossy run reproducible.
 */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive an independent seed for one stream of a run (one link, one client's
 * ack phase) so that adding a stream does not shift the numbers another stream
 * draws.
 */
export function deriveSeed(seed: number, stream: number): number {
  let mixed = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b);
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35) + Math.imul(stream + 1, 0x27d4eb2f);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}
