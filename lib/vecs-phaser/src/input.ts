/**
 * Compact input payload sent from client to server through
 * `ClientWorld.setInput` and delivered as the server-side `NetworkInput`
 * component. Field names are short on purpose — this object crosses the wire
 * every tick.
 *
 * Both ends must agree on the same ordered action list: the bit index of an
 * action is its index in that list (see {@link actionMask} /
 * {@link hasAction}).
 */
export interface InputPayload {
  /** Bitmask of active actions; bit index = action index in the shared order. */
  a: number;
  /** Pointer world X in meters, when pointer capture is enabled. */
  px?: number;
  /** Pointer world Y in meters (+y up), when pointer capture is enabled. */
  py?: number;
  /** Whether the pointer (mouse button / touch) is down. */
  pd?: boolean;
}

/**
 * Packs the active action names into a bitmask using `order` as the shared
 * bit assignment (bit index = index in `order`). Unknown names are ignored.
 */
export function actionMask(order: readonly string[], active: Iterable<string>): number {
  let mask = 0;
  for (const name of active) {
    const index = order.indexOf(name);
    if (index >= 0) {
      mask |= 1 << index;
    }
  }
  return mask >>> 0;
}

/**
 * True when `name`'s bit is set in `mask`, using `order` as the shared bit
 * assignment. Unknown names are never active.
 */
export function hasAction(mask: number, order: readonly string[], name: string): boolean {
  const index = order.indexOf(name);
  return index >= 0 && (mask & (1 << index)) !== 0;
}
