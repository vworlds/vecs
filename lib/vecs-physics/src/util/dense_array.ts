// Swap-pop removal for the dense arrays the solver sets keep packed (mirrors
// box2d's pattern of swapping the last element into a vacated slot, then
// fixing that element's stored index).

/**
 * Remove the element at `index` by swapping the last element into its place
 * and popping. O(1) and order-destroying.
 *
 * @returns The element that moved into `index` (so the caller can update its
 *   stored index/back-reference), or `undefined` when the removed element was
 *   already the last one and nothing moved.
 * @throws RangeError when `index` is out of bounds.
 */
export function swapRemove<T>(array: T[], index: number): T | undefined {
  const lastIndex = array.length - 1;
  if (index < 0 || index > lastIndex) {
    throw new RangeError(`swapRemove index ${index} out of range [0, ${lastIndex}]`);
  }
  if (index === lastIndex) {
    array.pop();
    return undefined;
  }
  const moved = array[lastIndex]!;
  array[index] = moved;
  array.pop();
  return moved;
}
