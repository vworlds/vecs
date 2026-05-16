import { Decoder } from "./decoder.js";
import { Encoder } from "./encoder.js";

export enum AnyType {
  null = 0,
  boolean = 1,
  undefined = 2,
  object = 3,
  empty_object = 4,
  array = 5,
  empty_array = 6,
  bigint_integer = 7,
  string = 8,
  empty_string = 9,
  number_integer = 10,
  number_unsigned = 11,
  number_float = 12,
  binary = 13,
  empty_binary = 14,
  bigint_unsigned = 15,
}

export class TagSize {
  constructor(
    public tag: AnyType,
    public size: number
  ) {}

  wireEncode(encoder: Encoder): void {
    if (this.size > 15) {
      encoder.write_u8(this.tag << 4);
      encoder.write_u32(this.size - 16);
    } else {
      encoder.write_u8((this.tag << 4) + this.size);
    }
  }

  static wireDecode(decoder: Decoder): TagSize {
    const byte = decoder.read_u8();
    const ts = new TagSize(byte >> 4, byte & 0x0f);
    if (ts.size === 0) {
      ts.size = decoder.read_u32() + 16;
    }
    return ts;
  }
}
