import { VecsStruct, type MemberScalarType } from "@vworlds/vecs";
import type { Decoder } from "./decoder.js";
import type { Encoder, IEncodable } from "./encoder.js";

/**
 * A scalar wire type. This is core's `MemberScalarType`, so a scalar added
 * there must gain a codec in `scalarMethods` or this package stops compiling.
 */
export type WireScalarType = MemberScalarType;

export type WireConstructor<T = unknown> = new () => T;
export type WireTypeSpec =
  WireScalarType | WireConstructor | readonly [WireScalarType | WireConstructor];

interface IWireField {
  key: string;
  spec: WireTypeSpec;
}

interface IStandardFieldDecoratorContext {
  kind: string;
  name: string | symbol;
  static: boolean;
  private: boolean;
  addInitializer(initializer: (this: object) => void): void;
}

type DecoratedConstructor<T = unknown> = (new () => T) & {
  wireDecode?: (decoder: Decoder) => T;
  prototype: IEncodable;
};

const scalarMethods: Record<MemberScalarType, { read: string; write: string }> = {
  bool: { read: "read_bool", write: "write_bool" },
  u8: { read: "read_u8", write: "write_u8" },
  i8: { read: "read_i8", write: "write_i8" },
  u16: { read: "read_u16", write: "write_u16" },
  i16: { read: "read_i16", write: "write_i16" },
  u32: { read: "read_u32", write: "write_u32" },
  i32: { read: "read_i32", write: "write_i32" },
  u64: { read: "read_u64", write: "write_u64" },
  i64: { read: "read_i64", write: "write_i64" },
  enum: { read: "read_enum", write: "write_enum" },
  f32: { read: "read_f32", write: "write_f32" },
  f64: { read: "read_f64", write: "write_f64" },
  string: { read: "read_string", write: "write_string" },
  bytes: { read: "read_bytes", write: "write_buffer" },
  any: { read: "read_any", write: "write_any" },
  // "entity" uses a custom codegen path (encode accesses .eid, decode returns
  // a raw number). These entries satisfy the Record type but are never called.
  entity: { read: "read_u32", write: "write_u32" },
};

const fieldsByConstructor = new WeakMap<Function, IWireField[]>();
const compiledConstructors = new WeakSet<Function>();

/**
 * Read a detached, frozen snapshot of registered wire fields, base classes first.
 * Reflection-only and non-wire classes return an empty array; use `VecsStruct.of(C)`
 * for reflection members. Standard decorators register when an
 * instance is constructed; construct one before reading their metadata.
 */
export function wireFields(
  C: abstract new () => unknown
): readonly { key: string; spec: WireTypeSpec }[] {
  return Object.freeze(
    getWireFields(C as DecoratedConstructor).map(({ key, spec }) =>
      Object.freeze({
        key,
        spec: Array.isArray(spec) ? (Object.freeze([...spec]) as WireTypeSpec) : spec,
      })
    )
  );
}

/**
 * Declare an encoded field. Any wire fields in the class chain take precedence
 * over all reflection members. Without wire fields or an explicit tag, the codec
 * snapshots `VecsStruct.of(C)` at first encode/decode; declare members before use.
 */
export function wireType(spec: WireTypeSpec): PropertyDecorator {
  assertValidSpec(spec);

  return (target, propertyKey) => {
    if (isStandardFieldDecoratorContext(propertyKey as unknown)) {
      registerStandardField(propertyKey as unknown as IStandardFieldDecoratorContext, spec);
      return;
    }

    if (typeof propertyKey !== "string") {
      throw new TypeError("vecs-wire/wireType only supports string property keys");
    }

    registerField(target.constructor as DecoratedConstructor, propertyKey, spec);
  };
}

/**
 * Register a class as a presence-only wire tag: a component with no encoded
 * fields. It encodes to zero bytes and decodes to a fresh instance, so its mere
 * presence on an entity is the payload. Usable as a class decorator (`@tag`) or
 * called directly (`tag(C)`).
 */
export function tag<T extends WireConstructor>(C: T): T {
  if (!fieldsByConstructor.has(C)) {
    fieldsByConstructor.set(C, []);
  }
  installTrampolines(C as unknown as DecoratedConstructor);
  return C;
}

function registerStandardField(context: IStandardFieldDecoratorContext, spec: WireTypeSpec): void {
  if (context.kind !== "field") {
    throw new TypeError("vecs-wire/wireType only supports standard field decorators");
  }
  if (context.static) {
    throw new TypeError("vecs-wire/wireType does not support static fields");
  }
  if (context.private) {
    throw new TypeError("vecs-wire/wireType does not support private fields");
  }
  if (typeof context.name !== "string") {
    throw new TypeError("vecs-wire/wireType only supports string property keys");
  }

  const key = context.name;
  context.addInitializer(function registerWireField(this: object): void {
    registerField(this.constructor as DecoratedConstructor, key, spec);
  });
}

function registerField(C: DecoratedConstructor, key: string, spec: WireTypeSpec): void {
  const fields = fieldsByConstructor.get(C) ?? [];
  const existing = fields.find((field) => field.key === key);
  if (existing !== undefined) {
    if (wireTypeSpecsEqual(existing.spec, spec)) {
      return;
    }
    throw new Error(`vecs-wire/wireType duplicate field ${key}`);
  }

  fields.push({ key, spec });
  fieldsByConstructor.set(C, fields);
  compiledConstructors.delete(C);
  installTrampolines(C);
}

function installTrampolines(C: DecoratedConstructor): void {
  if (!Object.prototype.hasOwnProperty.call(C.prototype, "wireEncode")) {
    C.prototype.wireEncode = function wireEncode(this: IEncodable, encoder: Encoder): void {
      compileWireType(this.constructor as DecoratedConstructor);
      this.wireEncode(encoder);
    };
  }

  if (!Object.prototype.hasOwnProperty.call(C, "wireDecode")) {
    C.wireDecode = function wireDecode(this: DecoratedConstructor, decoder: Decoder): unknown {
      compileWireType(this);
      return this.wireDecode!(decoder);
    };
  }
}

/** @internal Compile a registered wire layout or reflection fallback, if present. */
export function compileWireType(Class: WireConstructor): void {
  const C = Class as DecoratedConstructor;
  if (compiledConstructors.has(C)) {
    return;
  }

  let fields = getWireFields(C);
  const reflected = fields.length === 0 && !hasRegisteredWireType(C);
  if (reflected) {
    const struct = VecsStruct.of(C);
    if (struct === undefined) {
      return;
    }
    fields = Object.entries(struct.members).map(([key, member]) => ({ key, spec: member.type }));
  }

  const nestedTypes: WireConstructor[] = [];
  const encodeLines: string[] = [];
  const decodeLines: string[] = ["const value = new C();"];

  fields.forEach((field, index) => {
    emitEncodeField(encodeLines, field, index);
    emitDecodeField(decodeLines, field, index, nestedTypes);
  });
  decodeLines.push("return value;");

  const encodeFactory = new Function(
    "C",
    "compile",
    ...nestedTypes.map((_, index) => `T${index}`),
    `return function wireEncode(encoder) {
      ${reflected ? "if (this.constructor !== C) { compile(this.constructor); return this.wireEncode(encoder); }" : ""}
      ${encodeLines.join("\n")}
    };`
  ) as (...args: unknown[]) => (encoder: Encoder) => void;

  const decodeFactory = new Function(
    "C",
    "compile",
    ...nestedTypes.map((_, index) => `T${index}`),
    `return function wireDecode(decoder) {
      ${reflected ? "if (this !== C) { compile(this); return this.wireDecode(decoder); }" : ""}
      ${decodeLines.join("\n")}
    };`
  ) as (...args: unknown[]) => (decoder: Decoder) => unknown;

  const args = [C, compileWireType, ...nestedTypes];
  // Reflection-only subclasses have no decorator-installed trampolines. The
  // generated guards compile their own snapshot instead of reusing a base codec.
  C.prototype.wireEncode = encodeFactory(...args);
  C.wireDecode = decodeFactory(...args);
  compiledConstructors.add(C);
}

function getWireFields(C: DecoratedConstructor): IWireField[] {
  const constructors: Function[] = [];
  let current: Function | null = C;
  while (current !== null && current !== Function.prototype) {
    constructors.push(current);
    current = Object.getPrototypeOf(current) as Function | null;
  }

  const fields: IWireField[] = [];
  constructors.reverse().forEach((constructor) => {
    fieldsByConstructor.get(constructor)?.forEach((field) => {
      const inherited = fields.find((candidate) => candidate.key === field.key);
      if (inherited === undefined) {
        fields.push(field);
        return;
      }
      if (!wireTypeSpecsEqual(inherited.spec, field.spec)) {
        throw new Error(`vecs-wire/wireType duplicate inherited field ${field.key}`);
      }
    });
  });
  return fields;
}

function hasRegisteredWireType(C: DecoratedConstructor): boolean {
  let current: Function | null = C;
  while (current !== null && current !== Function.prototype) {
    if (fieldsByConstructor.has(current)) {
      return true;
    }
    current = Object.getPrototypeOf(current) as Function | null;
  }
  return false;
}

function emitEncodeField(lines: string[], field: IWireField, index: number): void {
  const access = `this[${JSON.stringify(field.key)}]`;

  if (isArraySpec(field.spec)) {
    const valueName = `a${index}`;
    lines.push(`const ${valueName} = ${access};`);
    lines.push(
      `if (!Array.isArray(${valueName})) throw new TypeError(${JSON.stringify(field.key)} + " must be an array");`
    );
    lines.push(`encoder.write_u32(${valueName}.length);`);
    lines.push(`for (let i${index} = 0; i${index} < ${valueName}.length; i${index}++) {`);
    lines.push(emitEncodeValue(`${valueName}[i${index}]`, field.spec[0]));
    lines.push("}");
    return;
  }

  lines.push(emitEncodeValue(access, field.spec));
}

function emitDecodeField(
  lines: string[],
  field: IWireField,
  index: number,
  nestedTypes: WireConstructor[]
): void {
  const access = `value[${JSON.stringify(field.key)}]`;

  if (isArraySpec(field.spec)) {
    const lengthName = `len${index}`;
    const valueName = `a${index}`;
    lines.push(`const ${lengthName} = decoder.read_u32();`);
    lines.push(`const ${valueName} = new Array(${lengthName});`);
    lines.push(`for (let i${index} = 0; i${index} < ${lengthName}; i${index}++) {`);
    lines.push(`${valueName}[i${index}] = ${emitDecodeValue(field.spec[0], nestedTypes)};`);
    lines.push("}");
    lines.push(`${access} = ${valueName};`);
    return;
  }

  lines.push(`${access} = ${emitDecodeValue(field.spec, nestedTypes)};`);
}

function emitEncodeValue(valueExpr: string, spec: WireScalarType | WireConstructor): string {
  if (spec === "entity") {
    return `encoder.write_u32(${valueExpr}.eid >>> 0);`;
  }
  if (isScalarSpec(spec)) {
    return `encoder.${scalarMethods[spec].write}(${valueExpr});`;
  }

  return `encoder.write(${valueExpr});`;
}

function emitDecodeValue(
  spec: WireScalarType | WireConstructor,
  nestedTypes: WireConstructor[]
): string {
  if (spec === "entity") {
    return `decoder.read_u32()`;
  }
  if (isScalarSpec(spec)) {
    return `decoder.${scalarMethods[spec].read}()`;
  }

  const nestedIndex = nestedTypes.length;
  nestedTypes.push(spec);
  return `decoder.read(T${nestedIndex})`;
}

function assertValidSpec(spec: WireTypeSpec): void {
  if (isArraySpec(spec)) {
    if (spec.length !== 1) {
      throw new TypeError("vecs-wire/wireType array specs must contain exactly one element type");
    }
    assertValidElementSpec(spec[0]);
    return;
  }

  assertValidElementSpec(spec);
}

function assertValidElementSpec(spec: WireScalarType | WireConstructor): void {
  if (spec === "entity" || isScalarSpec(spec) || typeof spec === "function") {
    return;
  }

  throw new TypeError(`vecs-wire/wireType unsupported type spec ${String(spec)}`);
}

function isArraySpec(spec: WireTypeSpec): spec is readonly [WireScalarType | WireConstructor] {
  return Array.isArray(spec);
}

function isScalarSpec(spec: WireScalarType | WireConstructor): spec is WireScalarType {
  return typeof spec === "string" && Object.prototype.hasOwnProperty.call(scalarMethods, spec);
}

function isStandardFieldDecoratorContext(value: unknown): value is IStandardFieldDecoratorContext {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "name" in value &&
    "addInitializer" in value
  );
}

function wireTypeSpecsEqual(left: WireTypeSpec, right: WireTypeSpec): boolean {
  if (isArraySpec(left) || isArraySpec(right)) {
    return isArraySpec(left) && isArraySpec(right) && left[0] === right[0];
  }

  return left === right;
}
