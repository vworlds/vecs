import { Decoder } from "./decoder.js";
import { Encoder, type IEncodable } from "./encoder.js";

export type WireScalarType =
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
  | "any";

export type WireConstructor<T = unknown> = new () => T;
export type WireTypeSpec =
  | WireScalarType
  | WireConstructor
  | readonly [WireScalarType | WireConstructor];

interface IWireField {
  key: string;
  spec: WireTypeSpec;
}

type DecoratedConstructor<T = unknown> = (new () => T) & {
  wireDecode?: (decoder: Decoder) => T;
  prototype: IEncodable;
};

const scalarMethods: Record<WireScalarType, { read: string; write: string }> = {
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
};

const fieldsByConstructor = new WeakMap<Function, IWireField[]>();
const compiledConstructors = new WeakSet<Function>();

export function type(spec: WireTypeSpec): PropertyDecorator {
  assertValidSpec(spec);

  return (target, propertyKey) => {
    if (typeof propertyKey !== "string") {
      throw new TypeError("vecs-wire/type only supports string property keys");
    }

    const C = target.constructor as DecoratedConstructor;
    const fields = fieldsByConstructor.get(C) ?? [];
    if (fields.some((field) => field.key === propertyKey)) {
      throw new Error(`vecs-wire/type duplicate field ${propertyKey}`);
    }

    fields.push({ key: propertyKey, spec });
    fieldsByConstructor.set(C, fields);
    compiledConstructors.delete(C);
    installTrampolines(C);
  };
}

function installTrampolines(C: DecoratedConstructor): void {
  if (!Object.prototype.hasOwnProperty.call(C.prototype, "wireEncode")) {
    C.prototype.wireEncode = function wireEncode(this: IEncodable, encoder: Encoder): void {
      compileWireType(C);
      this.wireEncode(encoder);
    };
  }

  if (!Object.prototype.hasOwnProperty.call(C, "wireDecode")) {
    C.wireDecode = function wireDecode(decoder: Decoder): unknown {
      compileWireType(C);
      return C.wireDecode!(decoder);
    };
  }
}

function compileWireType(C: DecoratedConstructor): void {
  if (compiledConstructors.has(C)) {
    return;
  }

  const fields = fieldsByConstructor.get(C);
  if (fields === undefined || fields.length === 0) {
    throw new Error(`vecs-wire/type ${C.name || "anonymous class"} has no decorated fields`);
  }

  const nestedTypes: WireConstructor[] = [];
  const encodeLines: string[] = [];
  const decodeLines: string[] = ["const value = new C();"];

  fields.forEach((field, index) => {
    emitEncodeField(encodeLines, field, index, nestedTypes);
    emitDecodeField(decodeLines, field, index, nestedTypes);
  });
  decodeLines.push("return value;");

  const encodeFactory = new Function(
    "C",
    ...nestedTypes.map((_, index) => `T${index}`),
    `return function wireEncode(encoder) {\n${encodeLines.join("\n")}\n};`
  ) as (...args: unknown[]) => (encoder: Encoder) => void;

  const decodeFactory = new Function(
    "C",
    ...nestedTypes.map((_, index) => `T${index}`),
    `return function wireDecode(decoder) {\n${decodeLines.join("\n")}\n};`
  ) as (...args: unknown[]) => (decoder: Decoder) => unknown;

  const args = [C, ...nestedTypes];
  C.prototype.wireEncode = encodeFactory(...args);
  C.wireDecode = decodeFactory(...args);
  compiledConstructors.add(C);
}

function emitEncodeField(
  lines: string[],
  field: IWireField,
  index: number,
  nestedTypes: WireConstructor[]
): void {
  const access = `this[${JSON.stringify(field.key)}]`;

  if (isArraySpec(field.spec)) {
    const valueName = `a${index}`;
    lines.push(`const ${valueName} = ${access};`);
    lines.push(
      `if (!Array.isArray(${valueName})) throw new TypeError(${JSON.stringify(field.key)} + " must be an array");`
    );
    lines.push(`encoder.write_u32(${valueName}.length);`);
    lines.push(`for (let i${index} = 0; i${index} < ${valueName}.length; i${index}++) {`);
    lines.push(emitEncodeValue(`${valueName}[i${index}]`, field.spec[0], nestedTypes));
    lines.push("}");
    return;
  }

  lines.push(emitEncodeValue(access, field.spec, nestedTypes));
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

function emitEncodeValue(
  valueExpr: string,
  spec: WireScalarType | WireConstructor,
  nestedTypes: WireConstructor[]
): string {
  if (isScalarSpec(spec)) {
    return `encoder.${scalarMethods[spec].write}(${valueExpr});`;
  }

  return `encoder.write(${valueExpr});`;
}

function emitDecodeValue(
  spec: WireScalarType | WireConstructor,
  nestedTypes: WireConstructor[]
): string {
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
      throw new TypeError("vecs-wire/type array specs must contain exactly one element type");
    }
    assertValidElementSpec(spec[0]);
    return;
  }

  assertValidElementSpec(spec);
}

function assertValidElementSpec(spec: WireScalarType | WireConstructor): void {
  if (isScalarSpec(spec) || typeof spec === "function") {
    return;
  }

  throw new TypeError(`vecs-wire/type unsupported type spec ${String(spec)}`);
}

function isArraySpec(spec: WireTypeSpec): spec is readonly [WireScalarType | WireConstructor] {
  return Array.isArray(spec);
}

function isScalarSpec(spec: WireScalarType | WireConstructor): spec is WireScalarType {
  return typeof spec === "string" && Object.prototype.hasOwnProperty.call(scalarMethods, spec);
}
