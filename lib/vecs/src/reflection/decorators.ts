import { assertMemberType, type MemberType, type RangeBound } from "./member_types.js";
import { type MemberDeclaration } from "./vecs_struct.js";

/**
 * A member decorator, usable as a legacy (`experimentalDecorators`) property
 * decorator or a standard (TC39) field decorator.
 */
export type MemberDecorator = PropertyDecorator &
  ((value: undefined, context: ClassFieldDecoratorContext) => void);

type Declarations = Map<string, MemberDeclaration>;

interface StandardFieldContext {
  kind: string;
  name: string | symbol;
  static: boolean;
  private: boolean;
  metadata?: Record<PropertyKey, unknown>;
  addInitializer(initializer: (this: object) => void): void;
}

const DECLARATIONS = Symbol("vecs.members");
const declarationsByClass = new WeakMap<Function, Declarations>();

// Standard decorators store their declarations in `context.metadata`, which
// TypeScript and esbuild provide only when `Symbol.metadata` exists. Defining it
// here, before any decorated class can be evaluated, lets `world.component(C)`
// read them without constructing an instance.
(Symbol as { metadata?: symbol }).metadata ??= Symbol.for("Symbol.metadata");

/**
 * Declare a member's type. Every member that carries metadata needs one.
 *
 * ```ts
 * class Position {
 *   @type("i32") @range(-100, 100) public x = 0;
 * }
 * ```
 *
 * @param memberType - A scalar type name, a nested component class, or an array `[type]`.
 */
export function type(memberType: MemberType): MemberDecorator {
  assertMemberType(memberType, "@type");
  return memberDecorator("@type", { type: memberType });
}

/**
 * Declare a numeric member's inclusive `[min, max]` range.
 *
 * Ranges are metadata: nothing checks them on `set`. The default `validate`
 * and `normalize` hooks check and clamp to them.
 */
export function range(min: RangeBound, max: RangeBound): MemberDecorator {
  return memberDecorator("@range", { range: [min, max] });
}

/** Declare a member's human-readable description. */
export function description(text: string): MemberDecorator {
  return memberDecorator("@description", { description: text });
}

/** Declare a member's unit of measure, for example `"m"`. */
export function unit(text: string): MemberDecorator {
  return memberDecorator("@unit", { unit: text });
}

/** Declare the allowed values of an `enum` member. */
export function values(allowed: readonly number[]): MemberDecorator {
  return memberDecorator("@values", { values: [...allowed] });
}

/** @internal Read the decorator declarations `Class` itself makes, in declaration order. */
export function _ownDecoratedMembers(Class: Function): [string, MemberDeclaration][] {
  return [...(declarationsByClass.get(Class) ?? []), ...(ownMetadataDeclarations(Class) ?? [])];
}

function memberDecorator(name: string, declaration: MemberDeclaration): MemberDecorator {
  return ((target: object, key: unknown) => {
    if (isStandardFieldContext(key)) {
      declareStandard(name, key, declaration);
      return;
    }
    if (typeof key !== "string") {
      throw new TypeError(`${name} only supports string property keys`);
    }
    const Class = (target as { constructor: Function }).constructor;
    let declarations = declarationsByClass.get(Class);
    if (declarations === undefined) {
      declarations = new Map();
      declarationsByClass.set(Class, declarations);
    }
    addDeclaration(declarations, `${Class.name}.${key}`, key, declaration);
  }) as MemberDecorator;
}

function declareStandard(
  name: string,
  context: StandardFieldContext,
  declaration: MemberDeclaration
): void {
  if (context.kind !== "field" || context.static || context.private) {
    throw new TypeError(`${name} only supports public instance fields`);
  }
  if (typeof context.name !== "string") {
    throw new TypeError(`${name} only supports string property keys`);
  }
  const key = context.name;
  const metadata = context.metadata;
  if (metadata !== undefined) {
    if (!Object.prototype.hasOwnProperty.call(metadata, DECLARATIONS)) {
      metadata[DECLARATIONS] = new Map();
    }
    addDeclaration(metadata[DECLARATIONS] as Declarations, key, key, declaration);
    return;
  }
  // Without metadata, fall back to registering on first construction.
  context.addInitializer(function declareMember(this: object): void {
    const Class = this.constructor;
    let declarations = declarationsByClass.get(Class);
    if (declarations === undefined) {
      declarations = new Map();
      declarationsByClass.set(Class, declarations);
    }
    if (!declarations.has(key) || !hasFields(declarations.get(key)!, declaration)) {
      addDeclaration(declarations, `${Class.name}.${key}`, key, declaration);
    }
  });
}

function addDeclaration(
  declarations: Declarations,
  where: string,
  key: string,
  declaration: MemberDeclaration
): void {
  const current = declarations.get(key) ?? {};
  for (const field of Object.keys(declaration) as (keyof MemberDeclaration)[]) {
    if (current[field] !== undefined) {
      throw new Error(`VecsStruct ${where}: ${field} is declared twice`);
    }
  }
  declarations.set(key, { ...current, ...declaration });
}

function hasFields(current: MemberDeclaration, declaration: MemberDeclaration): boolean {
  return (Object.keys(declaration) as (keyof MemberDeclaration)[]).every(
    (field) => current[field] !== undefined
  );
}

function ownMetadataDeclarations(constructor: Function): Declarations | undefined {
  const metadataKey = (Symbol as { metadata?: symbol }).metadata!;
  if (!Object.prototype.hasOwnProperty.call(constructor, metadataKey)) {
    return undefined;
  }
  const metadata = (constructor as unknown as Record<symbol, unknown>)[metadataKey];
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !Object.prototype.hasOwnProperty.call(metadata, DECLARATIONS)
  ) {
    return undefined;
  }
  return (metadata as Record<symbol, Declarations>)[DECLARATIONS];
}

function isStandardFieldContext(value: unknown): value is StandardFieldContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "name" in value &&
    "addInitializer" in value
  );
}
