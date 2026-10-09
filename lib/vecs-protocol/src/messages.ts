import type { EID } from "@vworlds/vecs";
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { ALL_COMPONENTS, cid_pack, cid_unpack } from "./cid.js";
import { RPC } from "./rpc.js";

const FIELD_DIFF = 1;
const FIELD_RPC = 2;
const FIELD_INPUT = 3;
const FIELD_CLOSE = 4;
const FIELD_RPC_SETTLED = 5;
const FIELD_DIFF_RESETS = 6;

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

/**
 * One removal of a single component in a {@link StateDiff}: the component of entity `eid` with
 * the given wire type. A whole entity is removed by an {@link EntityReset}, never by a
 * `RemovedComponent`, so `wireType` is never `ALL_COMPONENTS`.
 */
export type RemovedComponent = [eid: EID, wireType: number];

/**
 * The removal of a whole entity in a {@link StateDiff}, with the server frame at which it
 * happened: entity `eid` left the client's view (it was destroyed, or went out of sight) at
 * `frame`, which is never after the diff's `toFrame`.
 *
 * The frame is what makes a reset idempotent. A delta starts at the newest frame the server has
 * seen acked, so deltas that overlap while an ack is in flight each repeat the reset, and the
 * client tells one it has already applied (its frame is not past the frame the client holds)
 * from a new one.
 */
export type EntityReset = [eid: EID, frame: number];

/**
 * What changed in a client's view between two frames: the state to take it from frame
 * `fromFrame` to frame `toFrame`. A `fromFrame` of `0` makes it a baseline, the whole view as
 * of `toFrame`, which a client applies to an empty world.
 *
 * `snapshots` carry the new value of a component, which creates the entity if the client does
 * not hold it. `removed` lists single components that are gone. `resets` lists entities that
 * are gone altogether, each with the frame at which it happened.
 *
 * ### Order within a diff
 *
 * The lists carry no order of their own. A diff means this order, and every producer and
 * consumer of one must follow it:
 *
 * 1. the `resets`, each of which destroys the entity the client holds under its eid, if the
 *    client has not already (see below);
 * 2. the snapshots;
 * 3. the removals of single components.
 *
 * So a reset of an eid precedes every snapshot of that eid in the same diff: a diff that holds
 * both is telling the client that the entity it holds under that eid is gone, and that a new
 * entity, whose snapshots follow, has taken the eid. The server reuses the id of a destroyed
 * entity, and the wire carries no entity generation, so this is how a client tells the two
 * apart. A delta spanning several frames is merged to the same meaning: the newest reset of an
 * entity in the span is kept next to the snapshots and removals that follow it, which are the
 * whole of the new entity's state, and everything the span held for the entity before it is
 * dropped.
 *
 * A consumer that applied the snapshots first would create the new entity and then destroy it.
 *
 * ### Idempotence
 *
 * A reset applies only if its `frame` is newer than the frame the client held before the diff.
 * Otherwise the client has applied it already, in an earlier delta that overlaps this one, and
 * skips it: the snapshots and removals that follow update the entity in place. That is why a
 * removal of a single component recorded after a reset stays in the diff: a client that applies
 * the reset finds nothing to remove, and one that skips it needs the removal.
 *
 * ### Wire format
 *
 * `Server2Client` carries a diff without resets as field 1, exactly as it has always been, and
 * a diff with resets as field 6: the same body followed by a count and, for each reset, the eid
 * and `toFrame - frame`, both varints, so a reset that is still in the history costs a few
 * bytes. A peer that predates field 6 rejects it as an unknown tag. Deploy clients before
 * servers. A client reads field 1 from an older server as before, and takes a removal with wire
 * type `ALL_COMPONENTS` in its `removed` list as a reset at `toFrame`, which applies every time.
 * Encoded on its own, outside a `Server2Client`, a `StateDiff` always carries the count of resets.
 */
export class StateDiff implements IEncodable {
  public toFrame = 0;
  public fromFrame = 0;
  public snapshots: EncodedSnapshot[] = [];
  public removed: RemovedComponent[] = [];
  public resets: EntityReset[] = [];

  public constructor(values?: Partial<StateDiff>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    encodeDiffBody(this, encoder);
    encoder.write_u32(this.resets.length);
    this.resets.forEach(([eid, frame]) => {
      encoder.write_u32(eid);
      encoder.write_u32(this.toFrame - frame);
    });
  }

  public static wireDecode(decoder: Decoder): StateDiff {
    const diff = decodeDiffBody(decoder);
    const resetCount = decoder.read_u32();
    for (let i = 0; i < resetCount; i++) {
      const eid = decoder.read_u32();
      diff.resets.push([eid, diff.toFrame - decoder.read_u32()]);
    }
    return diff;
  }
}

// A diff without resets: field 1 of a Server2Client frame, which is all a diff was before resets.
function encodeDiffBody(diff: StateDiff, encoder: Encoder): void {
  encoder.write_u32(diff.toFrame);
  encoder.write_u32(diff.fromFrame);
  encoder.write_u32(diff.snapshots.length);
  diff.snapshots.forEach((snapshot) => encoder.write_buffer(snapshot.bytes));
  encoder.write_u32(diff.removed.length);
  diff.removed.forEach(([eid, wireType]) => encoder.write_u32(cid_pack(eid, wireType)));
}

function decodeDiffBody(decoder: Decoder): StateDiff {
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

// Field 1 as an older server writes it: whole-entity removals are `removed` entries with wire type
// ALL_COMPONENTS, which carry no frame. They become resets at `toFrame`, which a client applies.
function decodeLegacyDiff(decoder: Decoder): StateDiff {
  const diff = decodeDiffBody(decoder);
  if (diff.removed.some(([, wireType]) => wireType === ALL_COMPONENTS)) {
    diff.resets = diff.removed
      .filter(([, wireType]) => wireType === ALL_COMPONENTS)
      .map(([eid]): EntityReset => [eid, diff.toFrame]);
    diff.removed = diff.removed.filter(([, wireType]) => wireType !== ALL_COMPONENTS);
  }
  return diff;
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
  /** Present only on the graceful-close frame of a deliberate server close. */
  public close: CloseNotice | undefined;

  public constructor(values?: Partial<Server2Client>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    if (this.diff) {
      if (this.diff.resets.length > 0) {
        encoder.write_u8(FIELD_DIFF_RESETS);
        encoder.write(this.diff);
      } else {
        encoder.write_u8(FIELD_DIFF);
        encodeDiffBody(this.diff, encoder);
      }
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
          message.diff = decodeLegacyDiff(decoder);
          break;
        case FIELD_DIFF_RESETS:
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
        default:
          throw new Error(`Invalid Client2Server field tag ${tag}`);
      }
    }
    return message;
  }
}
