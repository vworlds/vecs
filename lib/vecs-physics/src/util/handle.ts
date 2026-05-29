// Internal (index, generation) handles. Never exposed to user code — public
// events resolve handles back to Vecs entities. The generation lets a slot be
// reused without a stale handle aliasing the new occupant.

/** An (index, generation) reference into an {@link IdPool}-managed slot. */
export interface Handle {
  index: number;
  generation: number;
}

// Phantom brands so a BodyHandle cannot be passed where a ShapeHandle is
// expected (and vice versa), even though both are structurally `Handle`. The
// brand exists only at the type level; there is no runtime field.
declare const BodyBrand: unique symbol;
declare const ShapeBrand: unique symbol;

/** Handle into the body table. */
export type BodyHandle = Handle & { readonly [BodyBrand]: "body" };

/** Handle into the shape table. */
export type ShapeHandle = Handle & { readonly [ShapeBrand]: "shape" };

/** Index value used for "no slot". */
export const NULL_INDEX = -1;

/** True when a handle refers to no slot. */
export function isNullHandle(handle: Handle): boolean {
  return handle.index < 0;
}
