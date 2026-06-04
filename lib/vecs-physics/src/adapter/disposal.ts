export interface EmscriptenAllocated {
  delete(): void;
}

/**
 * Every `new b2Xxx()` or factory allocation inside `src/adapter/` must use this
 * helper, or an explicit try/finally `.delete()` in the same function.
 */
export function withAllocated<TAllocated extends EmscriptenAllocated, TResult>(
  make: () => TAllocated,
  use: (allocated: TAllocated) => TResult
): TResult {
  const allocated = make();
  try {
    return use(allocated);
  } finally {
    allocated.delete();
  }
}
