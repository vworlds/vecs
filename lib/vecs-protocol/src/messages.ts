import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import { cid_pack, cid_unpack } from "./cid.js";
import { RPC } from "./rpc.js";

const FIELD_DIFF = 1;
const FIELD_RPC = 2;
const FIELD_INPUT = 3;

export class ComponentSnapshot implements IEncodable {
  public cid = 0;
  public payload = new Uint8Array();

  public constructor(values?: Partial<ComponentSnapshot>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    encoder.write_u32(this.cid);
    encoder.write_buffer(this.payload);
  }

  public static wireDecode(decoder: Decoder): ComponentSnapshot {
    return new ComponentSnapshot({
      cid: decoder.read_u32(),
      payload: decoder.read_bytes(),
    });
  }
}

export class EncodedSnapshot {
  public constructor(
    public bytes: Uint8Array,
    public cid = 0
  ) {}
}

export type RemovedComponent = [eid: number, type: number];

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
    this.removed.forEach(([eid, type]) => encoder.write_u32(cid_pack(eid, type)));
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

export class Server2Client implements IEncodable {
  public diff: StateDiff | undefined;
  public rpc: RPC[] = [];

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
