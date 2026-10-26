import { _ownDecoratedMembers } from "./decorators.js";
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
 * as `C` or a base class declares a member, through decorators ({@link type},
 * {@link range}, …) or the fluent {@link Component.member} API. Query it like
 * any component:
 *
 * ```ts
 * world.component(Position).get(VecsStruct)?.members.x; // { type: "i32", range: [-100, 100] }
 * ```
 *
 * The definition is per class for the whole process: every world attaches the
 * same frozen instance, so `getMut(VecsStruct, …)` on it throws. Members are
 * inherited, whichever way the base class declared them, and are listed base
 * class first, then in declaration order. A declaration that contradicts the
 * definition throws, naming the class and the member.
 */
export class VecsStruct {
  /** Member metadata keyed by member name. */
  public readonly members: Readonly<Record<string, VecsMember>> = {};

  /**
   * Read a class's process-wide, frozen definition without a world or instance.
   * Reads decorator and fluent declarations, composing base classes first.
   * Returns the same instance every world attaches, or `undefined` when neither
   * the class nor its bases declares members. Later declarations remain visible
   * through its `members` view.
   */
  public static of(Class: Function): VecsStruct | undefined {
    for (const C of _classChain(Class)) {
      _declareMembers(C, _ownDecoratedMembers(C));
    }
    return _structInstance(Class);
  }
}

/** A member declaration whose fields may still be incomplete. */
export interface MemberDeclaration {
  type?: MemberType;
  range?: readonly [RangeBound, RangeBound];
  description?: string;
  unit?: string;
  values?: readonly number[];
}

/** One class's own declarations and the frozen instance worlds attach for it. */
interface ClassDefinition {
  readonly Class: Function;
  /** Members this class declared, each already merged with what its bases declared then. */
  readonly own: Map<string, VecsMember>;
  readonly instance: VecsStruct;
  /** Composed members and their frozen view, valid while `version` is current. */
  cache: { version: number; members: Map<string, VecsMember>; view: object } | undefined;
}

const definitions = new WeakMap<Function, ClassDefinition>();
/** Base class → definitions of its subclasses that declare members of their own. */
const descendants = new WeakMap<Function, Set<ClassDefinition>>();
/** Bumped by every change, so composed caches along any class chain stay correct. */
let version = 0;

/**
 * @internal The class and its base classes, base class first.
 */
export function _classChain(Class: Function): Function[] {
  const chain: Function[] = [];
  for (
    let current: Function | null = Class;
    current !== null && current !== Function.prototype;
    current = Object.getPrototypeOf(current) as Function | null
  ) {
    chain.push(current);
  }
  return chain.reverse();
}

/**
 * @internal The composed members of `Class`, base class first, or `undefined`
 * when neither it nor a base class declares any. Reads the live definition.
 */
export function _structMembers(Class: Function): ReadonlyMap<string, VecsMember> | undefined {
  const members = composed(Class);
  return members.size === 0 ? undefined : members;
}

/**
 * @internal The frozen `VecsStruct` instance of `Class`, or `undefined` when it
 * has no members.
 */
export function _structInstance(Class: Function): VecsStruct | undefined {
  if (_structMembers(Class) === undefined) {
    return undefined;
  }
  return (definitions.get(Class) ?? createDefinition(Class)).instance;
}

/**
 * @internal Merge member declarations into the definition of `Class`.
 *
 * @returns `true` when the definition changed.
 * @throws When a declaration contradicts the definition of `Class`, of a base
 *   class, or of a subclass, or is malformed.
 */
export function _declareMembers(
  Class: Function,
  declarations: Iterable<readonly [string, MemberDeclaration]>
): boolean {
  let changed = false;
  for (const [name, declaration] of declarations) {
    const current = composed(Class).get(name);
    const merged = mergeMember(Class, name, current, declaration);
    if (merged === current) {
      continue;
    }
    for (const descendant of descendants.get(Class) ?? []) {
      const own = descendant.own.get(name);
      if (own !== undefined) {
        mergeMember(descendant.Class, name, merged, own);
      }
    }
    const definition = definitions.get(Class) ?? createDefinition(Class);
    if (definition.own.size === 0) {
      for (const base of _classChain(Class).slice(0, -1)) {
        let set = descendants.get(base);
        if (set === undefined) {
          set = new Set();
          descendants.set(base, set);
        }
        set.add(definition);
      }
    }
    definition.own.set(name, merged);
    version++;
    changed = true;
  }
  return changed;
}

function composed(Class: Function): Map<string, VecsMember> {
  const definition = definitions.get(Class);
  if (definition?.cache?.version === version) {
    return definition.cache.members;
  }
  const members = new Map<string, VecsMember>();
  for (const C of _classChain(Class)) {
    definitions.get(C)?.own.forEach((member, name) => {
      const inherited = members.get(name);
      members.set(name, inherited === undefined ? member : combine(inherited, member));
    });
  }
  if (definition !== undefined) {
    definition.cache = { version, members, view: freezeMembers(members) };
  }
  return members;
}

/** Fill a subclass's member with fields a base class declared after it. */
function combine(inherited: VecsMember, member: VecsMember): VecsMember {
  const next = { ...member } as { -readonly [K in keyof VecsMember]: VecsMember[K] };
  next.range ??= inherited.range;
  next.description ??= inherited.description;
  next.unit ??= inherited.unit;
  next.values ??= inherited.values;
  return membersEqual(next, member) ? member : Object.freeze(next);
}

function createDefinition(Class: Function): ClassDefinition {
  const instance = Object.create(VecsStruct.prototype) as VecsStruct;
  const definition: ClassDefinition = { Class, own: new Map(), instance, cache: undefined };
  definitions.set(Class, definition);
  // One instance per class: worlds that attached it before a later declaration,
  // here or on a base class, read the extended definition through it.
  Object.defineProperty(instance, "members", {
    enumerable: true,
    get: () => {
      composed(Class);
      return definition.cache!.view;
    },
  });
  Object.freeze(instance);
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
