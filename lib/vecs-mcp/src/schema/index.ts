import { wireFields, type WireConstructor, type WireTypeSpec } from "@vworlds/vecs-wire";
import { Entity, Relationship } from "@vworlds/vecs";

/** A field's bridge-only description and write constraints. */
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
  /** Return an error string to reject a set; draft is the whole merged component. */
  validate?: (value: unknown, draft: Readonly<Record<string, unknown>>) => string | void;
}

/** Merged component schema and bridge validation metadata. */
export interface ComponentSchema {
  /** JSON Schema using draft 2020-12 vocabulary. */
  schema: Record<string, unknown>;
  /** Effective fields, with explicit metadata taking precedence over wire and inference. */
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

const metadata = new WeakMap<Function, Map<string, FieldSpec>>();
const descriptions = new WeakMap<Function, string>();

/** Record a field description in legacy or standard decorator mode. No game hooks are installed. */
export function field(spec: FieldSpec): PropertyDecorator {
  return (target, key) => {
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
      context.addInitializer(function () {
        register(this.constructor, name, spec);
      });
    } else {
      if (typeof key !== "string") {
        throw new TypeError("field supports string fields only");
      }
      register(target.constructor, key, spec);
    }
  };
}

/** Record a component's human-readable description; works in both decorator modes. */
export function describe(text: string): <T extends Function>(C: T) => T {
  return (C) => {
    descriptions.set(C, text);
    return C;
  };
}

/** Construct an example and merge inference, wire metadata, and inherited field declarations. */
export function componentSchema(C: abstract new () => unknown): ComponentSchema {
  let example: object = {};
  try {
    example = new (C as WireConstructor)() as object;
  } catch {
    /* Resource types need not have a usable default constructor. */
  }
  const fields: Record<string, FieldSpec> = Object.create(null);
  for (const [key, value] of Object.entries(example)) {
    if (!(C.prototype instanceof Relationship && key === "_targets")) {
      fields[key] = infer(value, new Set());
    }
  }
  for (const { key, spec } of wireFields(C)) {
    fields[key] = { ...fields[key], ...fromWire(spec) };
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
    for (const [key, spec] of metadata.get(ancestor) ?? []) {
      fields[key] = { ...fields[key], ...spec };
    }
  }
  const schema = objectSchema(fields);
  return {
    fields,
    description,
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...schema,
      ...(description === undefined ? {} : { description }),
    },
  };
}

/**
 * Validate a whole merged draft and reject read-only keys present in patch.
 * Throws TypeError with field paths; validators run after all structural checks.
 * The caller owns merging patch over the current instance before calling.
 */
export function validateSet(
  C: abstract new () => unknown,
  draft: Record<string, unknown>,
  patch: Record<string, unknown>
): void {
  const { fields } = componentSchema(C);
  checkObject(fields, draft, patch, "");
  validateRules(fields, draft, draft);
}

function register(C: Function, key: string, spec: FieldSpec): void {
  let fields = metadata.get(C);
  if (!fields) {
    fields = new Map();
    metadata.set(C, fields);
  }
  fields.set(key, spec);
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
  if (spec.validate) {
    result["x-vecs-validated"] = true;
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
  }
  for (const [key, spec] of Object.entries(fields)) {
    const written = Object.prototype.hasOwnProperty.call(patch, key);
    if (written && containsReadOnly(spec)) {
      throw new TypeError(`${path}${key}: readOnly`);
    }
    checkValue(spec, value[key], written ? patch[key] : undefined, `${path}${key}`);
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
  if (spec.values && !spec.values.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    fail("not an enum member");
  }
  if (spec.min !== undefined && (typeof value !== "number" || value < spec.min)) {
    fail(`minimum ${spec.min}`);
  }
  if (spec.max !== undefined && (typeof value !== "number" || value > spec.max)) {
    fail(`maximum ${spec.max}`);
  }
}

function validateRules(
  fields: Readonly<Record<string, FieldSpec>>,
  value: Record<string, unknown>,
  draft: Record<string, unknown>,
  path = ""
): void {
  for (const [key, spec] of Object.entries(fields)) {
    const v = value[key];
    const message = spec.validate?.(v, draft);
    if (message) {
      throw new TypeError(`${path}${key}: ${message}`);
    }
    if (isPlain(v) && spec.fields) {
      validateRules(spec.fields, v, draft, `${path}${key}.`);
    }
    if (Array.isArray(v) && spec.items) {
      v.forEach((item, i) =>
        validateRules({ [i]: spec.items! }, { [i]: item }, draft, `${path}${key}.`)
      );
    }
  }
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
