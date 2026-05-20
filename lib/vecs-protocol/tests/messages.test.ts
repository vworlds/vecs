import { describe, expect, it } from "vitest";
import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";
import {
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  RPC,
  Server2Client,
  StateDiff,
  cid_pack,
} from "../src/index.js";

function encodeMessage(message: IEncodable, size = 64 * 1024): Uint8Array {
  const encoder = new Encoder(new Uint8Array(size));
  encoder.write(message);
  return encoder.getBuffer();
}

describe("protocol messages", () => {
  it("round-trips server diffs with snapshots, removals, and RPC", () => {
    const payload = Uint8Array.from([1, 2, 3]);
    const snapshotCid = cid_pack(12, 3);
    const snapshotBytes = encodeMessage(new ComponentSnapshot({ eid: 12, type: 3, payload }));
    const legacySnapshotBytes = new Encoder(new Uint8Array(64));
    legacySnapshotBytes.write_u32(snapshotCid);
    legacySnapshotBytes.write_buffer(payload);
    const message = new Server2Client({
      diff: new StateDiff({
        fromFrame: 5,
        toFrame: 6,
        snapshots: [new EncodedSnapshot(snapshotBytes, 12, 3)],
        removed: [[12, 4]],
      }),
      rpc: [new RPC({ rpcId: 0, callId: 9, params: ["ok"] })],
    });

    const decoded = new Decoder(encodeMessage(message)).read(Server2Client);

    expect(decoded.diff?.fromFrame).toBe(5);
    expect(decoded.diff?.toFrame).toBe(6);
    expect(decoded.diff?.removed).toEqual([[12, 4]]);
    expect(decoded.diff!.snapshots[0].eid).toBe(0);
    expect(decoded.diff!.snapshots[0].type).toBe(0);
    expect(snapshotBytes).toEqual(legacySnapshotBytes.getBuffer());
    expect(new Decoder(decoded.diff!.snapshots[0].bytes).read(ComponentSnapshot)).toEqual(
      new ComponentSnapshot({ eid: 12, type: 3, payload })
    );
    expect(decoded.rpc[0].params).toEqual(["ok"]);
  });

  it("round-trips client acks with arbitrary input", () => {
    const message = new Client2Server({
      ackFrame: 7,
      input: { keys: ["up"], aim: 90 },
      rpc: [new RPC({ rpcId: 101, callId: 1, params: [1, true] })],
    });

    const decoded = new Decoder(encodeMessage(message)).read(Client2Server);

    expect(decoded.ackFrame).toBe(7);
    expect(decoded.input).toEqual({ keys: ["up"], aim: 90 });
    expect(decoded.rpc[0].rpcId).toBe(101);
  });
});
