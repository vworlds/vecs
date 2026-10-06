import type { EID } from "@vworlds/vecs";
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { cid_pack, cid_unpack } from "./cid.js";
import { RPC } from "./rpc.js";

const FIELD_DIFF = 1;
const FIELD_RPC = 2;
const FIELD_INPUT = 3;
const FIELD_CLOSE = 4;

const CLOSE_HAS_CODE = 1;
const CLOSE_HAS_REASON = 2;

export class ComponentSnapshot implements IEncodable {
  public eid: EID = 0;
  public wireType = 0;
  public payload = new Uint8Array();

  public constructor(values?: Partial<ComponentSnapshot>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    encoder.write_u32(cid_pack(this.eid, this.wireType));
    encoder.write_buffer(this.payload);
  }

  public static wireDecode(decoder: Decoder): ComponentSnapshot {
    const [eid, wireType] = cid_unpack(decoder.read_u32());
    return new ComponentSnapshot({
      eid,
      wireType,
      payload: decoder.read_bytes(),
    });
  }
}

export class EncodedSnapshot {
  public constructor(
    public bytes: Uint8Array, // contains an already-encoded ComponentSnapshot
    public eid: EID = 0,
    public wireType = 0
  ) {}
}

export type RemovedComponent = [eid: EID, wireType: number];

export class StateDiff implements IEncodable {
  public toFrame = 0;
  public fromFrame = 0;
  public snapshots: EncodedSnapshot[] = [];
  public removed: RemovedComponent[] = [];

  public constructor(values?: Partial<StateDiff>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    encoder.write_u32(this.toFrame);
    encoder.write_u32(this.fromFrame);
    encoder.write_u32(this.snapshots.length);
    this.snapshots.forEach((snapshot) => encoder.write_buffer(snapshot.bytes));
    encoder.write_u32(this.removed.length);
    this.removed.forEach(([eid, wireType]) => encoder.write_u32(cid_pack(eid, wireType)));
  }

  public static wireDecode(decoder: Decoder): StateDiff {
    const diff = new StateDiff({ toFrame: decoder.read_u32(), fromFrame: decoder.read_u32() });
    const snapshotCount = decoder.read_u32();
    for (let i = 0; i < snapshotCount; i++) {
      diff.snapshots.push(new EncodedSnapshot(decoder.read_bytes()));
    }
    const removedCount = decoder.read_u32();
    for (let i = 0; i < removedCount; i++) {
      diff.removed.push(cid_unpack(decoder.read_u32()));
    }
    return diff;
  }
}

/**
 * Why the server closed a session on purpose, carried on the final frame of a
 * graceful close. Both fields are optional; codes `0`–`100` are reserved for
 * the protocol and applications use their own codes above that range.
 */
export interface CloseNotice {
  code?: number;
  reason?: string;
}

/**
 * The first protocol-reserved {@link CloseNotice.code}: the connection was
 * closed because a frame could not be decoded, usually because client and
 * server were built from incompatible protocol versions.
 *
 * Codes `0`–`100` are reserved for the protocol, and applications use their own
 * codes above that range. A frame fails to decode when it is truncated or
 * corrupt, or when it carries a field tag this build does not know. The reason
 * that accompanies the code always starts with `protocol error:` and continues
 * with the message of the error that caused the close.
 *
 * Both ends use it:
 *
 * - `ServerWorld` closes only the session that sent the frame, with this code,
 *   so the client's `disconnect` event reports it.
 * - `ClientWorld` reports it on its own `disconnect` event when it closes itself
 *   because a frame from the server, or a component snapshot inside one, cannot
 *   be decoded, or because the server sent a diff the client cannot accept: one
 *   that starts after the last frame the client acknowledged. Nothing is sent to
 *   the server in that case.
 *
 * `@vworlds/vecs-client` and `@vworlds/vecs-server` re-export it next to
 * `RPC_CLOSED_CODE`, so an application can compare against it without importing
 * this package.
 */
export const CLOSE_PROTOCOL_ERROR_CODE = 1;

export class Server2Client implements IEncodable {
  public diff: StateDiff | undefined;
  public rpc: RPC[] = [];
  /** Present only on the graceful-close frame of a deliberate server close. */
  public close: CloseNotice | undefined;

  public constructor(values?: Partial<Server2Client>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    if (this.diff) {
      encoder.write_u8(FIELD_DIFF);
      encoder.write(this.diff);
    }
    if (this.rpc.length > 0) {
      encoder.write_u8(FIELD_RPC);
      encoder.write_u32(this.rpc.length);
      this.rpc.forEach((rpc) => encoder.write(rpc));
    }
    if (this.close) {
      const { code, reason } = this.close;
      encoder.write_u8(FIELD_CLOSE);
      encoder.write_u8(
        (code !== undefined ? CLOSE_HAS_CODE : 0) | (reason !== undefined ? CLOSE_HAS_REASON : 0)
      );
      if (code !== undefined) {
        encoder.write_u32(code);
      }
      if (reason !== undefined) {
        encoder.write_string(reason);
      }
    }
  }

  public static wireDecode(decoder: Decoder): Server2Client {
    const message = new Server2Client();
    while (!decoder.EOF) {
      const tag = decoder.read_u8();
      switch (tag) {
        case FIELD_DIFF:
          message.diff = decoder.read(StateDiff);
          break;
        case FIELD_RPC: {
          const count = decoder.read_u32();
          for (let i = 0; i < count; i++) {
            message.rpc.push(decoder.read(RPC));
          }
          break;
        }
        case FIELD_CLOSE: {
          const flags = decoder.read_u8();
          const close: CloseNotice = {};
          if (flags & CLOSE_HAS_CODE) {
            close.code = decoder.read_u32();
          }
          if (flags & CLOSE_HAS_REASON) {
            close.reason = decoder.read_string();
          }
          message.close = close;
          break;
        }
        default:
          throw new Error(`Invalid Server2Client field tag ${tag}`);
      }
    }
    return message;
  }
}

export class Client2Server implements IEncodable {
  public ackFrame = 0;
  public input: unknown | undefined;
  public rpc: RPC[] = [];

  public constructor(values?: Partial<Client2Server>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    encoder.write_u32(this.ackFrame);
    if (this.input !== undefined) {
      encoder.write_u8(FIELD_INPUT);
      encoder.write_any(this.input);
    }
    if (this.rpc.length > 0) {
      encoder.write_u8(FIELD_RPC);
      encoder.write_u32(this.rpc.length);
      this.rpc.forEach((rpc) => encoder.write(rpc));
    }
  }

  public static wireDecode(decoder: Decoder): Client2Server {
    const message = new Client2Server({ ackFrame: decoder.read_u32() });
    while (!decoder.EOF) {
      const tag = decoder.read_u8();
      switch (tag) {
        case FIELD_INPUT:
          message.input = decoder.read_any();
          break;
        case FIELD_RPC: {
          const count = decoder.read_u32();
          for (let i = 0; i < count; i++) {
            message.rpc.push(decoder.read(RPC));
          }
          break;
        }
        default:
          throw new Error(`Invalid Client2Server field tag ${tag}`);
      }
    }
    return message;
  }
}
