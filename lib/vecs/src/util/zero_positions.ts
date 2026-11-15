/** Longest prefix copied from the template: twice the 1024-slot promotion slack. */
const TEMPLATE_LENGTH = 2048;
const TEMPLATE: number[] = [];
for (let i = 0; i < TEMPLATE_LENGTH; i++) {
  TEMPLATE.push(0);
}

/**
 * Build the zeroed position array of a container being promoted: `length`
 * zeros, packed exactly as if pushed one by one.
 *
 * Promotion runs once per representation change, so its code stays in a cold
 * JIT tier where pushing zeros one at a time is slow. A set that empties and
 * refills crosses the slack rule with eight members and up to 1,088 positions
 * each time. The first 2,048 slots are therefore one bulk copy of a shared
 * template; only larger arrays, which the density rule backs with at least
 * 128 members, push the remainder.
 * @internal
 */
export function zeroPositions(length: number): number[] {
  const positions = TEMPLATE.slice(0, length);
  while (positions.length < length) {
    positions.push(0);
  }
  return positions;
}
