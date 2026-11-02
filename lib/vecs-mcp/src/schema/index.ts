import { wireFields, type WireConstructor, type WireTypeSpec } from "@vworlds/vecs-wire";
import { Entity, VecsStruct, type World, type VecsMember } from "@vworlds/vecs";

/** MCP-only write policy; declare types and documentation with core decorators. */
export interface FieldExtras {
  /** Allow null or undefined. */
  optional?: boolean;
  /** Reject writes to this field, including nested writes. */
  readOnly?: boolean;
  /** MCP-only policy for array elements. */
  items?: FieldExtras;
  /** MCP-only policy for nested fields. */
  fields?: Readonly<Record<string, FieldExtras>>;
}

/** Effective JSON field constraints derived from core metadata and MCP extras. */
export interface FieldSpec {
  /** JSON value kind; entity is an integer eid, any imposes no type constraint. */
  type?:
    "number" | "integer" | "string" | "boolean" | "entity" | "enum" | "object" | "array" | "any";
  /** Human-readable field documentation. */
  description?: string;
  /** Physical or application unit, emitted as x-vecs-unit. */
  unit?: string;
  /** Inclusive numeric minimum. */
  min?: number;
  /** Inclusive numeric maximum. */
  max?: number;
  /** Allowed JSON enum values. */
  values?: readonly unknown[];
  /** Array element constraints. */
  items?: FieldSpec;
  /** Nested plain-object fields. */
  fields?: Readonly<Record<string, FieldSpec>>;
  /** Allow null or undefined. */
  optional?: boolean;
  /** Reject writes to this field, including nested writes. */
  readOnly?: boolean;
}

/** Merged component schema and bridge validation metadata. */
export interface ComponentSchema {
  /** JSON Schema using draft 2020-12 vocabulary. */
  schema: Record<string, unknown>;
  /** Core members (or metadata-free inference) with inherited MCP extras. */
  fields: Readonly<Record<string, FieldSpec>>;
  /** Inherited class description, if declared. */
  description?: string;
}

interface StandardContext {
  kind: string;
  name: string | symbol;
  static: boolean;
  private: boolean;
  addInitializer(fn: (this: object) => void): void;
}

const extras = new WeakMap<Function, Map<string, FieldExtras>>();
const descriptions = new WeakMap<Function, string>();
const schemas = new WeakMap<
  Function,
  { generation: number; reflection: unknown[]; value: ComponentSchema }
>();
let generation = 0;

/** Record MCP-only optional/readOnly policy in legacy or standard decorator mode. */
export function field(
  spec: FieldExtras
): PropertyDecorator & ((value: undefined, context: ClassFieldDecoratorContext) => void) {
  return ((target: object, key: unknown) => {
    if (typeof key === "object" && key !== null) {
      const context = key as unknown as StandardContext;
      if (
        context.kind !== "field" ||
        context.static ||
        context.private ||
        typeof context.name !== "string"
      ) {
        throw new TypeError("field supports public, non-static string fields only");
      }
      const name = context.name;
      // Each decorator registers once per concrete class. Separate sets preserve
      // base/derived overrides of the same key without replaying them per instance.
      const registered = new WeakSet<Function>();
      context.addInitializer(function () {
        if (registered.has(this.constructor)) {
          return;
        }
        registered.add(this.constructor);
        register(this.constructor, name, spec);
      });
    } else {
      if (typeof key !== "string") {
        throw new TypeError("field supports string fields only");
      }
      register(target.constructor, key, spec);
    }
  }) as ReturnType<typeof field>;
}

/** Record a component's human-readable description; works in both decorator modes. */
export function describe(text: string): <T extends Function>(C: T) => T {
  return (C) => {
    descriptions.set(C, text);
    generation++;
    return C;
  };
}

/**
 * Read core members, falling back to instance/wire inference only when absent.
 * Overlay inherited MCP extras. Cached until reflection or MCP metadata changes;
 * cache misses construct one example for inference and standard initializers.
 * Treat the returned schema and metadata as read-only.
 */
export function componentSchema(C: abstract new () => unknown): ComponentSchema {
  const cached = schemas.get(C);
  const reflection = reflectionSignature(C);
  if (
    cached?.generation === generation &&
    cached.reflection.length === reflection.length &&
    cached.reflection.every((v, i) => v === reflection[i])
  ) {
    return cached.value;
  }
  let example: object = {};
  try {
    example = new (C as WireConstructor)() as object;
  } catch {
    /* Resource types need not have a usable default constructor. */
  }
  const fields: Record<string, FieldSpec> = Object.create(null);
  const members = VecsStruct.of(C)?.members;
  if (members) {
    for (const [key, member] of Object.entries(members)) {
      fields[key] = fromMember(member);
    }
  } else {
    for (const [key, value] of Object.entries(example)) {
      fields[key] = infer(value, new Set());
    }
    for (const { key, spec } of wireFields(C)) {
      fields[key] = { ...fields[key], ...fromWire(spec) };
    }
  }
  const chain: Function[] = [];
  for (
    let current: Function | null = C;
    current && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    chain.unshift(current);
  }
  let description: string | undefined;
  for (const ancestor of chain) {
    description = descriptions.get(ancestor) ?? description;
    for (const [key, spec] of extras.get(ancestor) ?? []) {
      fields[key] = mergeExtras(fields[key] ?? {}, spec);
    }
  }
  const schema = objectSchema(fields);
  const value: ComponentSchema = {
    fields,
    description,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...schema,
      ...(description === undefined ? {} : { description }),
    },
  };
  // Constructing the example can register standard decorators and advance generation.
  schemas.set(C, { generation, reflection: reflectionSignature(C), value });
  return value;
}

/**
 * Check structural constraints only for patch keys, recursively, and reject
 * written read-only fields. Then call world.validate on a class-prototyped copy
 * of the whole merged draft. Violation messages are preserved (lists joined by newlines).
 * The caller owns merging patch over the current instance before calling.
 * Register C in the target world first. Hooks must be pure: the bridge calls
 * this during preflight and again immediately before writing.
 */
export function validateSet(
  world: World,
  C: abstract new () => unknown,
  draft: Record<string, unknown>,
  patch: Record<string, unknown>
): void {
  const { fields } = componentSchema(C);
  checkObject(fields, draft, patch, "");
  const result = world.validate(Object.assign(Object.create(C.prototype), draft));
  if (result !== true) {
    throw new TypeError(typeof result === "string" ? result : result.join("\n"));
  }
}

function register(C: Function, key: string, spec: FieldExtras): void {
  let fields = extras.get(C);
  if (fields?.get(key) === spec) {
    return;
  }
  if (!fields) {
    fields = new Map();
    extras.set(C, fields);
  }
  fields.set(key, spec);
  generation++;
}

function reflectionSignature(C: Function, seen = new Set<Function>()): unknown[] {
  if (seen.has(C)) {
    return [];
  }
  seen.add(C);
  const members = VecsStruct.of(C)?.members;
  return [
    C,
    members,
    ...Object.values(members ?? {}).flatMap(({ type }) => {
      const element = Array.isArray(type) ? type[0] : type;
      return typeof element === "function" ? reflectionSignature(element, seen) : [];
    }),
  ];
}

function mergeExtras(spec: FieldSpec, policy: FieldExtras): FieldSpec {
  const result = { ...spec, ...policy } as FieldSpec;
  if (policy.items) {
    result.items = mergeExtras(spec.items ?? {}, policy.items);
  }
  if (policy.fields) {
    result.fields = {
      ...spec.fields,
      ...Object.fromEntries(
        Object.entries(policy.fields).map(([key, value]) => [
          key,
          mergeExtras(spec.fields?.[key] ?? {}, value),
        ])
      ),
    };
  }
  return result;
}

function fromMember(member: VecsMember): FieldSpec {
  const spec = fromWire(member.type);
  const constraints = {
    ...(member.range ? { min: Number(member.range[0]), max: Number(member.range[1]) } : {}),
    ...(member.values === undefined ? {} : { values: member.values }),
  };
  return {
    ...spec,
    ...(spec.type === "array" ? { items: { ...spec.items, ...constraints } } : constraints),
    ...(member.description === undefined ? {} : { description: member.description }),
    ...(member.unit === undefined ? {} : { unit: member.unit }),
  };
}

function infer(value: unknown, seen: Set<object>): FieldSpec {
  if (value === null || value === undefined) {
    return { optional: true };
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return { type: typeof value as "number" | "string" | "boolean" };
  }
  if (typeof value !== "object" || seen.has(value)) {
    return {};
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return { type: "array", items: value.length ? infer(value[0], seen) : {} };
    }
    if (
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null
    ) {
      return {
        type: "object",
        fields: Object.fromEntries(Object.entries(value).map(([key, v]) => [key, infer(v, seen)])),
      };
    }
    return {};
  } finally {
    seen.delete(value);
  }
}

function fromWire(spec: WireTypeSpec): FieldSpec {
  if (Array.isArray(spec)) {
    return { type: "array", items: fromWire(spec[0]) };
  }
  if (typeof spec === "function") {
    return { type: "object", fields: componentSchema(spec).fields };
  }
  switch (spec) {
    case "bool":
      return { type: "boolean" };
    case "string":
      return { type: "string" };
    case "entity":
      return { type: "entity" };
    case "any":
      return { type: "any" };
    case "enum":
      return { type: "enum" };
    case "bytes":
      return {};
    case "f32":
    case "f64":
      return { type: "number" };
    default:
      return { type: "integer" };
  }
}

function objectSchema(fields: Readonly<Record<string, FieldSpec>>): Record<string, unknown> {
  return {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(fields).map(([key, spec]) => [key, jsonSchema(spec)])
    ),
    required: Object.keys(fields).filter((key) => !fields[key].optional),
    additionalProperties: false,
  };
}

function jsonSchema(spec: FieldSpec): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  if (spec.type === "object") {
    Object.assign(schema, objectSchema(spec.fields ?? {}));
  } else if (spec.type === "entity") {
    Object.assign(schema, { type: "integer", "x-vecs-entity": true });
  } else if (spec.type && spec.type !== "any" && spec.type !== "enum") {
    schema.type = spec.type;
  }
  if (spec.values) {
    schema.enum = spec.values;
  }
  if (spec.items) {
    schema.items = jsonSchema(spec.items);
  }
  if (spec.min !== undefined) {
    schema.minimum = spec.min;
  }
  if (spec.max !== undefined) {
    schema.maximum = spec.max;
  }
  const result: Record<string, unknown> = spec.optional
    ? { anyOf: [schema, { type: "null" }] }
    : schema;
  if (spec.description !== undefined) {
    result.description = spec.description;
  }
  if (spec.unit !== undefined) {
    result["x-vecs-unit"] = spec.unit;
  }
  if (spec.readOnly) {
    result.readOnly = true;
  }
  return result;
}

function checkObject(
  fields: Readonly<Record<string, FieldSpec>>,
  value: Record<string, unknown>,
  patch: Record<string, unknown>,
  path: string
): void {
  for (const key of Object.keys(patch)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new TypeError(`${path}${key}: unknown field`);
    }
    const spec = fields[key];
    if (containsReadOnly(spec)) {
      throw new TypeError(`${path}${key}: readOnly`);
    }
    checkValue(spec, value[key], patch[key], `${path}${key}`);
  }
}

function containsReadOnly(spec: FieldSpec): boolean {
  return (
    !!spec.readOnly ||
    Object.values(spec.fields ?? {}).some(containsReadOnly) ||
    (spec.items !== undefined && containsReadOnly(spec.items))
  );
}

function checkValue(spec: FieldSpec, value: unknown, patch: unknown, path: string): void {
  if (spec.type === "entity" && value instanceof Entity) {
    value = value.eid;
  }
  if (value === null || value === undefined) {
    if (spec.optional || !spec.type || spec.type === "any") {
      return;
    }
    throw new TypeError(`${path}: required ${spec.type}`);
  }
  const fail = (message: string): never => {
    throw new TypeError(`${path}: ${message}`);
  };
  switch (spec.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("expected number");
      }
      break;
    case "integer":
    case "entity":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        fail(`expected ${spec.type}`);
      }
      break;
    case "string":
    case "boolean":
      if (typeof value !== spec.type) {
        fail(`expected ${spec.type}`);
      }
      break;
    case "object":
      if (!isPlain(value)) {
        fail("expected plain object");
      }
      checkObject(
        spec.fields ?? {},
        value as Record<string, unknown>,
        isPlain(patch) ? patch : {},
        `${path}.`
      );
      break;
    case "array":
      if (!Array.isArray(value)) {
        fail("expected array");
      }
      (value as unknown[]).forEach((v, i) => {
        if (patch !== undefined && spec.items?.readOnly) {
          fail("readOnly items");
        }
        checkValue(
          spec.items ?? {},
          v,
          Array.isArray(patch) ? patch[i] : undefined,
          `${path}[${i}]`
        );
      });
      break;
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
