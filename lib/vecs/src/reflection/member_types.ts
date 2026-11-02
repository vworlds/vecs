// Member type vocabulary shared by reflection, decorators and default hooks.
//
// `lib/vecs-wire/src/decorators.ts` reads `MemberScalarType` from here as
// `WireScalarType`; this is the only declaration of the scalar names.

/**
 * A scalar member type.
 *
 * Integer types (`u8` … `i64`, `enum`) have fixed bounds; `u64` and `i64` hold
 * `bigint` values. `enum` is an `i32` whose allowed values a member may list.
 * `entity` holds an entity reference.
 */
export type MemberScalarType =
  | "bool"
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "enum"
  | "f32"
  | "f64"
  | "string"
  | "bytes"
  | "any"
  | "entity";

/** A nested component class used as a member type. */
export type MemberClass<T = unknown> = new () => T;

/** The type of one array element: a scalar or a nested component class. */
export type MemberElementType = MemberScalarType | MemberClass;

/** A member type: a scalar, a nested component class, or an array `[type]`. */
export type MemberType = MemberElementType | readonly [MemberElementType];

/** A range bound. `u64` and `i64` members accept `bigint` bounds. */
export type RangeBound = number | bigint;

/**
 * Reflection metadata for one component member, as stored in
 * {@link VecsStruct.members}.
 */
export interface VecsMember {
  /** The member's type. */
  readonly type: MemberType;
  /** Inclusive `[min, max]` bounds. Metadata only: nothing checks it on `set`. */
  readonly range?: readonly [min: RangeBound, max: RangeBound];
  /** Human-readable description. */
  readonly description?: string;
  /** Unit of measure, for example `"m"` or `"deg"`. */
  readonly unit?: string;
  /** Allowed values of an `enum` member. */
  readonly values?: readonly number[];
}

/** @internal Integer bounds per integer scalar type. */
export const INTEGER_BOUNDS: Readonly<
  Partial<Record<MemberScalarType, readonly [number, number] | readonly [bigint, bigint]>>
> = {
  u8: [0, 0xff],
  i8: [-0x80, 0x7f],
  u16: [0, 0xffff],
  i16: [-0x8000, 0x7fff],
  u32: [0, 0xffffffff],
  i32: [-0x80000000, 0x7fffffff],
  enum: [-0x80000000, 0x7fffffff],
  u64: [0n, 0xffffffffffffffffn],
  i64: [-0x8000000000000000n, 0x7fffffffffffffffn],
};

const SCALAR_TYPES: ReadonlySet<string> = new Set<MemberScalarType>([
  "bool",
  "u8",
  "i8",
  "u16",
  "i16",
  "u32",
  "i32",
  "u64",
  "i64",
  "enum",
  "f32",
  "f64",
  "string",
  "bytes",
  "any",
  "entity",
]);

/** @internal Whether `type` is an array member type. */
export function isArrayType(type: MemberType): type is readonly [MemberElementType] {
  return Array.isArray(type);
}

/** @internal The element type of an array member, or the type itself. */
export function elementType(type: MemberType): MemberElementType {
  return isArrayType(type) ? type[0] : type;
}

/** @internal Whether `type` is a numeric scalar: an integer type, `f32` or `f64`. */
export function isNumericType(type: MemberElementType): type is MemberScalarType {
  return type === "f32" || type === "f64" || isIntegerType(type);
}

/** @internal Whether `type` is an integer scalar, including `enum`, `u64` and `i64`. */
export function isIntegerType(type: MemberElementType): type is MemberScalarType {
  return typeof type === "string" && INTEGER_BOUNDS[type] !== undefined;
}

/** @internal Whether `type` holds `bigint` values. */
export function isBigIntType(type: MemberElementType): boolean {
  return type === "u64" || type === "i64";
}

/** @internal Throw a `TypeError` unless `type` is a valid member type. */
export function assertMemberType(type: unknown, where: string): asserts type is MemberType {
  if (Array.isArray(type)) {
    if (type.length !== 1) {
      throw new TypeError(`${where}: an array type must contain exactly one element type`);
    }
    assertElementType(type[0], where);
    return;
  }
  assertElementType(type, where);
}

/** @internal Compare two member types: same scalar, same class, or arrays of the same element. */
export function memberTypesEqual(left: MemberType, right: MemberType): boolean {
  if (isArrayType(left) || isArrayType(right)) {
    return isArrayType(left) && isArrayType(right) && left[0] === right[0];
  }
  return left === right;
}

/** @internal Render a member type for error messages. */
export function formatMemberType(type: MemberType): string {
  if (isArrayType(type)) {
    return `[${formatMemberType(type[0])}]`;
  }
  return typeof type === "function" ? type.name || "anonymous class" : type;
}

function assertElementType(type: unknown, where: string): void {
  if (typeof type === "function" || (typeof type === "string" && SCALAR_TYPES.has(type))) {
    return;
  }
  throw new TypeError(`${where}: unsupported member type ${String(type)}`);
}
