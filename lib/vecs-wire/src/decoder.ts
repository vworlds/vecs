import { AnyType, TagSize } from "./any.js";

export interface IDecodable<T> {
  wireDecode(decoder: Decoder): T;
}

const maxSafeBigInt = BigInt(Number.MAX_SAFE_INTEGER);
const minSafeBigInt = BigInt(Number.MIN_SAFE_INTEGER);

function canConvertToNumber(bigintValue: bigint): boolean {
  return bigintValue <= maxSafeBigInt && bigintValue >= minSafeBigInt;
}

export class Decoder {
  private readonly _buffer: Uint8Array;
  private _cursor = 0;

  constructor(buffer: Uint8Array) {
    this._buffer = buffer;
  }

  public get EOF(): boolean {
    return this._cursor >= this._buffer.length;
  }

  read_varint_u32(): number {
    let result = 0;
    let shift = 0;
    let byte: number;

    do {
      if (this._cursor >= this._buffer.length) {
        throw new RangeError("vecs-wire/decoder read_u32: Attempt to read beyond buffer size");
      }
      byte = this._buffer[this._cursor++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);

    return result >>> 0;
  }

  read_varint_u64(): bigint {
    let result = BigInt(0);
    let shift = 0;
    let byte: number;

    do {
      if (this._cursor >= this._buffer.length) {
        throw new RangeError("vecs-wire/decoder read_u64: Attempt to read beyond buffer size");
      }
      byte = this._buffer[this._cursor++];
      result |= BigInt(byte & 0x7f) << BigInt(shift);
      shift += 7;
    } while (byte & 0x80);

    return result;
  }

  decode_zz_u32(value: number): number {
    return (value >>> 1) ^ -(value & 1);
  }

  decode_zz_u64(value: bigint): bigint {
    return (value >> BigInt(1)) ^ -(value & BigInt(1));
  }

  read_u8(): number {
    if (this._cursor >= this._buffer.length) {
      throw new RangeError("vecs-wire/decoder read_u8: Attempt to read beyond buffer size");
    }
    return this._buffer[this._cursor++];
  }

  read_i8(): number {
    return (this.read_u8() << 24) >> 24;
  }

  read_bool(): boolean {
    return this.read_u8() !== 0;
  }

  read_u16(): number {
    return this.read_varint_u32();
  }

  read_u32(): number {
    return this.read_varint_u32();
  }

  read_u64(): bigint {
    return this.read_varint_u64();
  }

  read_i16(): number {
    return this.decode_zz_u32(this.read_varint_u32());
  }

  read_i32(): number {
    return this.decode_zz_u32(this.read_varint_u32());
  }

  read_enum(): number {
    return this.read_i32();
  }

  read_i64(): bigint {
    return this.decode_zz_u64(this.read_varint_u64());
  }

  read_f32(): number {
    if (this._cursor + 4 > this._buffer.length) {
      throw new RangeError("vecs-wire/decoder read_f32: Attempt to read beyond buffer size");
    }
    const value = new DataView(
      this._buffer.buffer,
      this._buffer.byteOffset + this._cursor,
      4
    ).getFloat32(0, true);
    this._cursor += 4;
    return value;
  }

  read_f64(): number {
    if (this._cursor + 8 > this._buffer.length) {
      throw new RangeError("vecs-wire/decoder read_f64: Attempt to read beyond buffer size");
    }
    const value = new DataView(
      this._buffer.buffer,
      this._buffer.byteOffset + this._cursor,
      8
    ).getFloat64(0, true);
    this._cursor += 8;
    return value;
  }

  read_buffer_raw(len: number): Uint8Array {
    if (this._cursor + len > this._buffer.length) {
      throw new RangeError("vecs-wire/decoder read_buffer_raw: Attempt to read beyond buffer size");
    }
    const buf = this._buffer.subarray(this._cursor, this._cursor + len);
    this._cursor += len;
    return buf;
  }

  read_string(): string {
    const len = this.read_u32();
    if (len === 0) {
      return "";
    }
    return new TextDecoder().decode(this.read_buffer_raw(len));
  }

  read_bytes(): Uint8Array {
    const len = this.read_u32();
    return this.read_buffer_raw(len);
  }

  read_any(): unknown {
    const ts = this.read(TagSize);
    switch (ts.tag) {
      case AnyType.null:
        return null;
      case AnyType.boolean:
        return ts.size === 1;
      case AnyType.empty_object:
        return {};
      case AnyType.object: {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < ts.size; i++) {
          const key = this.read_string();
          const value = this.read_any();
          obj[key] = value;
        }
        return obj;
      }
      case AnyType.empty_array:
        return [];
      case AnyType.array: {
        const arr: unknown[] = [];
        for (let i = 0; i < ts.size; i++) {
          arr.push(this.read_any());
        }
        return arr;
      }
      case AnyType.empty_string:
        return "";
      case AnyType.string:
        return new TextDecoder().decode(this.read_buffer_raw(ts.size));
      case AnyType.number_integer: {
        const bi = this.read_i64();
        return canConvertToNumber(bi) ? Number(bi) : bi;
      }
      case AnyType.number_unsigned: {
        const bi = this.read_u64();
        return canConvertToNumber(bi) ? Number(bi) : bi;
      }
      case AnyType.number_float:
        return ts.size === 4 ? this.read_f32() : this.read_f64();
      case AnyType.empty_binary:
        return this.read_buffer_raw(0);
      case AnyType.binary:
        return this.read_buffer_raw(ts.size);
      default:
        throw new Error(`Unsupported any tag ${ts.tag}`);
    }
  }

  read<T>(C: IDecodable<T>): T {
    return C.wireDecode(this);
  }
}
