# vecs-wire

Binary serialization utilities for `vecs` networking packages.

`@vworlds/vecs-wire` provides a small TypeScript encoder/decoder pair for writing deterministic binary messages into caller-owned `Uint8Array` buffers. It is used by the protocol, client, and server packages to encode primitive values, flexible `any` payloads, and custom classes that implement `wireEncode` / `wireDecode`.

## Install

This package is part of the vecs monorepo and is currently consumed through workspace dependencies.

```sh
npm install
```

```ts
import { Decoder, Encoder } from "@vworlds/vecs-wire";
```

## Concepts

| Concept      | What it is                                                               |
| ------------ | ------------------------------------------------------------------------ |
| `Encoder`    | Writes typed values into a fixed-size `Uint8Array`.                      |
| `Decoder`    | Reads typed values from an encoded `Uint8Array`.                         |
| `IEncodable` | Interface for custom classes with a `wireEncode(encoder)` method.        |
| `IDecodable` | Interface for custom classes with a static `wireDecode(decoder)` method. |
| `@type`      | Decorator that generates `wireEncode` / `wireDecode` for simple classes. |
| `any`        | Tagged dynamic payload format for arbitrary input and RPC parameters.    |

## Basic Usage

Create an encoder with a buffer large enough for the message, write values in order, and pass `encoder.getBuffer()` to consumers. Decode by reading values in the same order.

```ts
import { Decoder, Encoder } from "@vworlds/vecs-wire";

const encoder = new Encoder(new Uint8Array(1024));

encoder.write_u32(42);
encoder.write_string("hello");
encoder.write_bool(true);

const bytes = encoder.getBuffer();
const decoder = new Decoder(bytes);

const id = decoder.read_u32();
const name = decoder.read_string();
const active = decoder.read_bool();
```

`getBuffer()` returns a view over the bytes written so far. It does not copy the underlying data.

## Scalar Types

The scalar methods are paired by name. Values must be read in exactly the same order and type shape they were written.

| Type                    | Write method   | Read method   | JavaScript value |
| ----------------------- | -------------- | ------------- | ---------------- |
| Boolean                 | `write_bool`   | `read_bool`   | `boolean`        |
| Unsigned 8-bit integer  | `write_u8`     | `read_u8`     | `number`         |
| Signed 8-bit integer    | `write_i8`     | `read_i8`     | `number`         |
| Unsigned 16-bit integer | `write_u16`    | `read_u16`    | `number`         |
| Signed 16-bit integer   | `write_i16`    | `read_i16`    | `number`         |
| Unsigned 32-bit integer | `write_u32`    | `read_u32`    | `number`         |
| Signed 32-bit integer   | `write_i32`    | `read_i32`    | `number`         |
| Unsigned 64-bit integer | `write_u64`    | `read_u64`    | `bigint`         |
| Signed 64-bit integer   | `write_i64`    | `read_i64`    | `bigint`         |
| Enum                    | `write_enum`   | `read_enum`   | `number`         |
| 32-bit float            | `write_f32`    | `read_f32`    | `number`         |
| 64-bit float            | `write_f64`    | `read_f64`    | `number`         |
| UTF-8 string            | `write_string` | `read_string` | `string`         |
| Bytes                   | `write_buffer` | `read_bytes`  | `Uint8Array`     |
| Dynamic value           | `write_any`    | `read_any`    | `unknown`        |

Integer values use variable-length encoding. Signed integers use zigzag encoding. Strings are UTF-8 encoded and length-prefixed. Byte buffers are length-prefixed and decoded as `Uint8Array` views over the original encoded buffer.

## Custom Classes

Custom message classes can implement `IEncodable` and expose a static `wireDecode` method.

```ts
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";

class PlayerInput implements IEncodable {
  public frame = 0;
  public moveX = 0;
  public jump = false;

  public constructor(values?: Partial<PlayerInput>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    encoder.write_u32(this.frame);
    encoder.write_f32(this.moveX);
    encoder.write_bool(this.jump);
  }

  public static wireDecode(decoder: Decoder): PlayerInput {
    return new PlayerInput({
      frame: decoder.read_u32(),
      moveX: decoder.read_f32(),
      jump: decoder.read_bool(),
    });
  }
}

const encoder = new Encoder(new Uint8Array(128));
encoder.write(new PlayerInput({ frame: 10, moveX: 1, jump: true }));

const decoded = new Decoder(encoder.getBuffer()).read(PlayerInput);
```

Use this style when a message needs optional fields, field tags, version handling, validation, or custom construction logic.

## Decorated Classes

The `type` decorator can generate `wireEncode` and `wireDecode` for classes with a fixed field order.

```ts
import { Decoder, Encoder, type } from "@vworlds/vecs-wire";

class Position {
  @type("f32")
  public x = 0;

  @type("f32")
  public y = 0;
}

class Snapshot {
  @type("u32")
  public entityId = 0;

  @type(Position)
  public position = new Position();

  @type(["u32"])
  public visibleTo: number[] = [];
}

const value = new Snapshot();
value.entityId = 7;
value.position.x = 1;
value.position.y = 2;
value.visibleTo = [10, 11];

const encoder = new Encoder(new Uint8Array(256));
encoder.write(value);

const decoded = new Decoder(encoder.getBuffer()).read(Snapshot);
```

Decorator specs can be scalar names, decorated classes, or single-element arrays of scalar names or decorated classes.

```ts
@type("u32")
public id = 0;

@type(Position)
public position = new Position();

@type([Position])
public trail: Position[] = [];
```

Decorated classes are best for compact fixed-layout payloads. They do not write field names or optional field tags, so changing the decorated field list changes the wire format.

## Dynamic `any` Values

`write_any` and `read_any` encode a tagged dynamic value. This format is used for flexible payloads such as client input and RPC parameters.

Supported shapes include:

- `null`
- `boolean`
- `string`
- `number`
- `bigint`
- `Uint8Array`
- arrays containing supported values
- plain objects with string keys and supported values

```ts
const payload = {
  keys: ["up", "left"],
  aim: 90,
  meta: { sprint: true },
};

const encoder = new Encoder(new Uint8Array(1024));
encoder.write_any(payload);

const decoded = new Decoder(encoder.getBuffer()).read_any();
```

Prefer explicit scalar fields for stable protocol messages. Use `any` when callers need application-defined JSON-like data or RPC parameters.

## Buffers And Bounds

Encoders write into a fixed-size buffer supplied by the caller. If a write would exceed the buffer length, the encoder throws a `RangeError`.

```ts
const encoder = new Encoder(new Uint8Array(8));
encoder.write_string("too large for this buffer"); // throws RangeError
```

Decoders also throw `RangeError` when asked to read beyond the available bytes. Use `decoder.EOF` when reading tagged messages with a variable number of fields.

```ts
while (!decoder.EOF) {
  const field = decoder.read_u8();
  // Dispatch by field tag.
}
```

## Wire Compatibility

The wire format is order-sensitive. For fixed-layout messages, the encoder and decoder must agree on the exact sequence of fields and scalar methods.

For evolving messages, prefer explicit field tags and a manual `wireEncode` / `wireDecode` implementation:

```ts
const FIELD_NAME = 1;

class Message {
  public name = "";

  public wireEncode(encoder: Encoder): void {
    if (this.name.length > 0) {
      encoder.write_u8(FIELD_NAME);
      encoder.write_string(this.name);
    }
  }

  public static wireDecode(decoder: Decoder): Message {
    const message = new Message();
    while (!decoder.EOF) {
      switch (decoder.read_u8()) {
        case FIELD_NAME:
          message.name = decoder.read_string();
          break;
        default:
          throw new Error("Invalid Message field tag");
      }
    }
    return message;
  }
}
```

## Development

Run package-level checks while working on `vecs-wire`:

```sh
npm --workspace @vworlds/vecs-wire test
npm --workspace @vworlds/vecs-wire run typecheck
npm --workspace @vworlds/vecs-wire run lint
```

Run repository-level checks before committing behavior changes:

```sh
npm run test
npm run typecheck
npm run lint
npm run format:check
```
