import type { EID } from "@vworlds/vecs";
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { cid_pack, cid_unpack } from "./cid.js";
import { RPC } from "./rpc.js";

const FIELD_DIFF = 1;
const FIELD_RPC = 2;
const FIELD_INPUT = 3;
const FIELD_CLOSE = 4;
const FIELD_RPC_SETTLED = 5;
const FIELD_OPTIMISTIC = 6;
const FIELD_GAP = 7;

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
 *   that starts after the last frame the client acknowledged without being marked
 *   {@link Server2Client.optimistic}. Nothing is sent to the server in that case.
 *
 * `@vworlds/vecs-client` and `@vworlds/vecs-server` re-export it next to
 * `RPC_CLOSED_CODE`, so an application can compare against it without importing
 * this package.
 */
export const CLOSE_PROTOCOL_ERROR_CODE = 1;

export class Server2Client implements IEncodable {
  public diff: StateDiff | undefined;
  public rpc: RPC[] = [];
  /**
   * The server's RPC low watermark, `SessionRPC.settledBelow`: every call the
   * server issued with a `callId` below this value has settled. The client
   * passes it to `SessionRPC.setPeerSettledBelow` on receipt, which lets it
   * drop the replies it kept for those calls and ignore any copy of their
   * requests that still arrives.
   *
   * Encoded as tag 5 and a `u32` only when above `0`, so a frame from a server
   * that never issued a call, which is every frame `ServerWorld` sends today, is
   * byte-identical to one built before the field existed. A decoder that
   * predates the field rejects the tag, so older clients still decode
   * `ServerWorld`'s frames only because it never sends the field today.
   */
  public rpcSettledBelow = 0;
  /**
   * The frame's diff starts past the last frame the server saw the client
   * acknowledge: it is an *optimistic* delta, built on the assumption that the
   * client already holds the frames in between because the server sent them in
   * earlier frames that have not been acked yet (`ServerWorldOptions.redundancyFrames`).
   *
   * A client that has not yet received those frames cannot apply the diff. For an
   * unmarked diff that is a protocol error; for a marked one it is a gap: the
   * client holds the diff until the missing frames arrive, and reports the gap in
   * {@link Client2Server.gap} so the server falls back to deltas from the ack.
   *
   * Encoded as tag 6 and no payload only when `true`, so every frame of a server
   * that does not enable `redundancyFrames`, which is every frame `ServerWorld`
   * sends by default, is byte-identical to one built before the field existed. A
   * decoder that predates the field rejects the tag, so deploy clients before
   * enabling `redundancyFrames` on a server.
   */
  public optimistic = false;
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
    if (this.rpcSettledBelow > 0) {
      encoder.write_u8(FIELD_RPC_SETTLED);
      encoder.write_u32(this.rpcSettledBelow);
    }
    if (this.optimistic) {
      encoder.write_u8(FIELD_OPTIMISTIC);
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
        case FIELD_RPC_SETTLED:
          message.rpcSettledBelow = decoder.read_u32();
          break;
        case FIELD_OPTIMISTIC:
          message.optimistic = true;
          break;
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
  /**
   * The client's RPC low watermark, `SessionRPC.settledBelow`: every call the
   * client issued with a `callId` below this value has settled. The server
   * passes it to `SessionRPC.setPeerSettledBelow` on receipt, which lets it
   * drop the replies it kept for those calls and ignore any copy of their
   * requests that still arrives, such as a retransmit that was delayed on the
   * unordered transport.
   *
   * Encoded as tag 5 and a `u32` only when above `0`, so a frame from a client
   * that never made a call, or whose first call has not settled, is
   * byte-identical to one built before the field existed. A decoder that
   * predates the field rejects the tag, and a client sends it once its first
   * call has settled, so deploy servers before clients: a new server reads old
   * and new clients alike, but an older server cannot read a new client's
   * frame. One that predates the guard for undecodable frames throws out of its
   * receive handler (vworlds/vecs#211); one that has it closes that client's
   * session with {@link CLOSE_PROTOCOL_ERROR_CODE} instead.
   */
  public rpcSettledBelow = 0;
  /**
   * The client holds an optimistic diff it cannot apply yet, because the frames
   * before it have not arrived: a gap (see {@link Server2Client.optimistic}). The
   * server answers by sending the session deltas from its acked frame until the
   * client has caught up.
   *
   * Encoded as tag 7 and no payload only when `true`. A client only ever sets it
   * after receiving a frame marked optimistic, which a server sends only when
   * `ServerWorldOptions.redundancyFrames` is set, so for any other server every
   * frame is byte-identical to one built before the field existed.
   */
  public gap = false;

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
    if (this.rpcSettledBelow > 0) {
      encoder.write_u8(FIELD_RPC_SETTLED);
      encoder.write_u32(this.rpcSettledBelow);
    }
    if (this.gap) {
      encoder.write_u8(FIELD_GAP);
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
        case FIELD_RPC_SETTLED:
          message.rpcSettledBelow = decoder.read_u32();
          break;
        case FIELD_GAP:
          message.gap = true;
          break;
        default:
          throw new Error(`Invalid Client2Server field tag ${tag}`);
      }
    }
    return message;
  }
}
