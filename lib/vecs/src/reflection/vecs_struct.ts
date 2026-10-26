import {
  assertMemberType,
  elementType,
  formatMemberType,
  isBigIntType,
  isNumericType,
  memberTypesEqual,
  type MemberType,
  type RangeBound,
  type VecsMember,
} from "./member_types.js";

/**
 * Core component holding a component class's member reflection metadata.
 *
 * `world.component(C)` attaches it to the **component entity** of `C` as soon
 * as `C` declares a member, through decorators ({@link type}, {@link range},
 * …) or the fluent {@link Component.member} API. Query it like any component:
 *
 * ```ts
 * world.component(Position).get(VecsStruct)?.members.x; // { type: "i32", range: [-100, 100] }
 * ```
 *
 * The definition is per class for the whole process: every world attaches the
 * same frozen instance, so `getMut(VecsStruct, …)` on it throws. Members are
 * listed base class first, then in declaration order. A declaration that
 * contradicts the definition throws, naming the class and the member.
 */
export class VecsStruct {
  /** Member metadata keyed by member name. */
  public readonly members: Readonly<Record<string, VecsMember>> = {};
}

/** A member declaration whose fields may still be incomplete. */
export interface MemberDeclaration {
  type?: MemberType;
  range?: readonly [RangeBound, RangeBound];
  description?: string;
  unit?: string;
  values?: readonly number[];
}

/** @internal The process-wide definition of one class. */
export interface StructDefinition {
  /** Declared members, in definition order. */
  readonly members: ReadonlyMap<string, VecsMember>;
  /** The frozen instance every world attaches. */
  readonly instance: VecsStruct;
}

interface MutableDefinition extends StructDefinition {
  readonly Class: Function;
  readonly members: Map<string, VecsMember>;
  view: Readonly<Record<string, VecsMember>> | undefined;
}

const definitions = new WeakMap<Function, MutableDefinition>();

/** @internal The process-wide definition of `Class`, or `undefined` when it declares no member. */
export function _structDefinition(Class: Function): StructDefinition | undefined {
  return definitions.get(Class);
}

/**
 * @internal Merge member declarations into the process-wide definition of
 * `Class`, creating the definition on the first declaration.
 *
 * @returns `true` when the definition changed.
 * @throws When a declaration contradicts the definition or is malformed.
 */
export function _declareMembers(
  Class: Function,
  declarations: Iterable<readonly [string, MemberDeclaration]>
): boolean {
  let changed = false;
  for (const [name, declaration] of declarations) {
    let definition = definitions.get(Class);
    const existing = definition?.members.get(name);
    const merged = mergeMember(Class, name, existing, declaration);
    if (merged === existing) {
      continue;
    }
    definition ??= createDefinition(Class);
    definition.members.set(name, merged);
    definition.view = undefined;
    changed = true;
  }
  return changed;
}

function createDefinition(Class: Function): MutableDefinition {
  const instance = Object.create(VecsStruct.prototype) as VecsStruct;
  const definition: MutableDefinition = {
    Class,
    members: new Map(),
    view: undefined,
    instance,
  };
  // One instance per class: worlds that registered the class before a later
  // declaration read the extended definition through the same object.
  Object.defineProperty(instance, "members", {
    enumerable: true,
    get: () => (definition.view ??= freezeMembers(definition.members)),
  });
  Object.freeze(instance);
  definitions.set(Class, definition);
  return definition;
}

function freezeMembers(members: ReadonlyMap<string, VecsMember>): Record<string, VecsMember> {
  const view: Record<string, VecsMember> = {};
  for (const [name, member] of members) {
    view[name] = member;
  }
  return Object.freeze(view);
}

function mergeMember(
  Class: Function,
  name: string,
  existing: VecsMember | undefined,
  declaration: MemberDeclaration
): VecsMember {
  const where = `VecsStruct ${Class.name || "anonymous class"}.${name}`;
  const type = declaration.type ?? existing?.type;
  if (type === undefined) {
    throw new TypeError(`${where}: member metadata needs a type`);
  }
  assertMemberType(type, where);

  const next: { -readonly [K in keyof VecsMember]: VecsMember[K] } = { ...existing, type };
  if (existing !== undefined && !memberTypesEqual(existing.type, type)) {
    throw contradiction(where, "type", formatMemberType(type), formatMemberType(existing.type));
  }
  if (declaration.range !== undefined) {
    const range = normalizeRange(where, type, declaration.range);
    if (existing?.range !== undefined) {
      if (existing.range[0] !== range[0] || existing.range[1] !== range[1]) {
        throw contradiction(where, "range", formatRange(range), formatRange(existing.range));
      }
    } else {
      next.range = range;
    }
  }
  for (const field of ["description", "unit"] as const) {
    const value = declaration[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "string") {
      throw new TypeError(`${where}: ${field} must be a string`);
    }
    if (existing?.[field] !== undefined && existing[field] !== value) {
      throw contradiction(where, field, JSON.stringify(value), JSON.stringify(existing[field]));
    }
    next[field] = value;
  }
  if (declaration.values !== undefined) {
    const values = normalizeValues(where, type, declaration.values);
    if (existing?.values !== undefined) {
      if (!valuesEqual(existing.values, values)) {
        throw contradiction(where, "values", formatValues(values), formatValues(existing.values));
      }
    } else {
      next.values = values;
    }
  }

  if (existing !== undefined && membersEqual(existing, next)) {
    return existing;
  }
  return Object.freeze(next);
}

function normalizeRange(
  where: string,
  type: MemberType,
  range: readonly [RangeBound, RangeBound]
): readonly [RangeBound, RangeBound] {
  const element = elementType(type);
  if (!isNumericType(element)) {
    throw new TypeError(`${where}: range needs a numeric type, not ${formatMemberType(type)}`);
  }
  if (!Array.isArray(range) || range.length !== 2) {
    throw new TypeError(`${where}: range must be [min, max]`);
  }
  let [min, max] = range;
  if (isBigIntType(element)) {
    min = toBigInt(where, min);
    max = toBigInt(where, max);
  } else if (typeof min !== "number" || typeof max !== "number" || isNaN(min) || isNaN(max)) {
    throw new TypeError(`${where}: range bounds of a ${formatMemberType(type)} must be numbers`);
  }
  if (min > max) {
    throw new RangeError(`${where}: range min ${min} is above max ${max}`);
  }
  return Object.freeze([min, max] as const);
}

function toBigInt(where: string, value: RangeBound): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${where}: range bounds of a 64-bit member must be integers`);
  }
  return BigInt(value);
}

function normalizeValues(
  where: string,
  type: MemberType,
  values: readonly number[]
): readonly number[] {
  if (elementType(type) !== "enum") {
    throw new TypeError(`${where}: values needs an enum type, not ${formatMemberType(type)}`);
  }
  if (!Array.isArray(values) || !values.every((value) => Number.isInteger(value))) {
    throw new TypeError(`${where}: enum values must be integers`);
  }
  return Object.freeze([...values]);
}

function membersEqual(left: VecsMember, right: VecsMember): boolean {
  return (
    memberTypesEqual(left.type, right.type) &&
    left.range?.[0] === right.range?.[0] &&
    left.range?.[1] === right.range?.[1] &&
    left.description === right.description &&
    left.unit === right.unit &&
    (left.values === right.values ||
      (left.values !== undefined &&
        right.values !== undefined &&
        valuesEqual(left.values, right.values)))
  );
}

function valuesEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function contradiction(where: string, field: string, declared: string, current: string): Error {
  return new Error(`${where}: ${field} ${declared} contradicts the existing ${field} ${current}`);
}

function formatRange(range: readonly [RangeBound, RangeBound]): string {
  return `[${range[0]}, ${range[1]}]`;
}

function formatValues(values: readonly number[]): string {
  return `[${values.join(", ")}]`;
}
