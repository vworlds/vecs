import { AnyType, TagSize } from "./any.js";

export interface IEncodable {
  wireEncode(encoder: Encoder): void;
}

function canBeFloat(value: number): boolean {
  if (value === 0 || !Number.isFinite(value) || Number.isNaN(value)) {
    return true;
  }

  const floatMin = -3.4028235e38;
  const floatMax = 3.4028235e38;
  if (value < floatMin || value > floatMax) {
    return false;
  }

  return value === Math.fround(value);
}

export class Encoder {
  private readonly _buffer: Uint8Array;
  private _cursor = 0;

  constructor(buffer: Uint8Array) {
    this._buffer = buffer;
  }

  getBuffer(): Uint8Array {
    return this._buffer.subarray(0, this._cursor);
  }

  reset(): void {
    this._cursor = 0;
  }

  get length(): number {
    return this._cursor;
  }

  write_varint_u32(value: number): void {
    while (value > 0x7f) {
      if (this._cursor >= this._buffer.length) {
        throw new RangeError(
          "vecs-wire/encoder write_varint_u32: Attempt to write beyond buffer size"
        );
      }
      this._buffer[this._cursor++] = (value & 0x7f) | 0x80;
      value >>>= 7;
    }
    if (this._cursor >= this._buffer.length) {
      throw new RangeError(
        "vecs-wire/encoder write_varint_u32: Attempt to write beyond buffer size"
      );
    }
    this._buffer[this._cursor++] = value;
  }

  write_varint_u64(value: bigint): void {
    while (value > 0x7fn) {
      if (this._cursor >= this._buffer.length) {
        throw new RangeError(
          "vecs-wire/encoder write_varint_u64: Attempt to write beyond buffer size"
        );
      }
      this._buffer[this._cursor++] = Number((value & 0x7fn) | 0x80n);
      value >>= 7n;
    }
    if (this._cursor >= this._buffer.length) {
      throw new RangeError(
        "vecs-wire/encoder write_varint_u64: Attempt to write beyond buffer size"
      );
    }
    this._buffer[this._cursor++] = Number(value);
  }

  encode_zz_u32(value: number): number {
    return (value << 1) ^ (value >> 31);
  }

  encode_zz_u64(value: bigint): bigint {
    return (value << 1n) ^ (value >> 63n);
  }

  write_u8(value: number): void {
    if (this._cursor >= this._buffer.length) {
      throw new RangeError("vecs-wire/encoder write_u8: Attempt to write beyond buffer size");
    }
    this._buffer[this._cursor++] = value;
  }

  write_i8(value: number): void {
    this.write_u8(value & 0xff);
  }

  write_bool(value: boolean): void {
    this.write_u8(value ? 1 : 0);
  }

  write_u16(value: number): void {
    this.write_varint_u32(value);
  }

  write_u32(value: number): void {
    this.write_varint_u32(value);
  }

  write_u64(value: bigint): void {
    this.write_varint_u64(value);
  }

  write_i16(value: number): void {
    this.write_varint_u32(this.encode_zz_u32(value));
  }

  write_i32(value: number): void {
    this.write_varint_u32(this.encode_zz_u32(value));
  }

  write_enum(value: number): void {
    this.write_i32(value);
  }

  write_i64(value: bigint): void {
    this.write_varint_u64(this.encode_zz_u64(value));
  }

  write_f32(value: number): void {
    if (this._cursor + 4 > this._buffer.length) {
      throw new RangeError("vecs-wire/encoder write_f32: Attempt to write beyond buffer size");
    }
    new DataView(this._buffer.buffer, this._buffer.byteOffset + this._cursor, 4).setFloat32(
      0,
      value,
      true
    );
    this._cursor += 4;
  }

  write_f64(value: number): void {
    if (this._cursor + 8 > this._buffer.length) {
      throw new RangeError("vecs-wire/encoder write_f64: Attempt to write beyond buffer size");
    }
    new DataView(this._buffer.buffer, this._buffer.byteOffset + this._cursor, 8).setFloat64(
      0,
      value,
      true
    );
    this._cursor += 8;
  }

  private _write_buffer_raw(data: Uint8Array, len: number = data.length): void {
    if (this._cursor + len > this._buffer.length) {
      throw new RangeError("vecs-wire/encoder write_buffer: Attempt to write beyond buffer size");
    }
    this._buffer.set(data.subarray(0, len), this._cursor);
    this._cursor += len;
  }

  write_buffer(data: Uint8Array, len: number = data.length): void {
    this.write_u32(len);
    this._write_buffer_raw(data, len);
  }

  write_string(value: string): void {
    const encodedString = new TextEncoder().encode(value);
    this.write_u32(encodedString.length);
    this._write_buffer_raw(encodedString, encodedString.length);
  }

  write_any(value: unknown): void {
    switch (typeof value) {
      case "undefined":
        this.write(new TagSize(AnyType.undefined, 1));
        break;
      case "boolean":
        this.write(new TagSize(AnyType.boolean, value ? 1 : 2));
        break;
      case "string": {
        const encodedString = new TextEncoder().encode(value);
        if (encodedString.length === 0) {
          this.write(new TagSize(AnyType.empty_string, 1));
        } else {
          this.write(new TagSize(AnyType.string, encodedString.length));
          this._write_buffer_raw(encodedString, encodedString.length);
        }
        break;
      }
      case "number":
        if (Number.isInteger(value)) {
          this.write(new TagSize(AnyType.number_integer, 8));
          this.write_i64(BigInt(value));
        } else if (canBeFloat(value)) {
          this.write(new TagSize(AnyType.number_float, 4));
          this.write_f32(value);
        } else {
          this.write(new TagSize(AnyType.number_float, 8));
          this.write_f64(value);
        }
        break;
      case "bigint":
        if (value < 0n) {
          this.write(new TagSize(AnyType.bigint_integer, 8));
          this.write_i64(value);
        } else {
          this.write(new TagSize(AnyType.bigint_unsigned, 8));
          this.write_u64(value);
        }
        break;
      case "object":
        if (value === null) {
          this.write(new TagSize(AnyType.null, 1));
        } else if (value instanceof Uint8Array) {
          this.write(new TagSize(AnyType.binary, value.length));
          this._write_buffer_raw(value);
        } else if (Array.isArray(value)) {
          if (value.length === 0) {
            this.write(new TagSize(AnyType.empty_array, 1));
          } else {
            this.write(new TagSize(AnyType.array, value.length));
            value.forEach((v) => {
              this.write_any(v);
            });
          }
        } else {
          const entries = Object.entries(value);
          if (entries.length === 0) {
            this.write(new TagSize(AnyType.empty_object, 1));
          } else {
            this.write(new TagSize(AnyType.object, entries.length));
            entries.forEach(([key, entryValue]) => {
              this.write_string(key);
              this.write_any(entryValue);
            });
          }
        }
        break;
      default:
        throw new Error(`Unsupported type ${typeof value} encoding any`);
    }
  }

  write(value: IEncodable | object): void {
    const encodable = value as IEncodable;
    if (typeof encodable.wireEncode !== "function") {
      throw new TypeError("vecs-wire/encoder write requires a wireEncode method");
    }
    encodable.wireEncode(this);
  }
}
