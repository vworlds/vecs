import { describe, expect, it } from "vitest";
import { Decoder } from "@vworlds/vecs-wire";
import {
  Client2Server,
  ComponentSnapshot,
  RemovedComponent,
  RPC,
  Server2Client,
  StateDiff,
  encodeMessage,
} from "../src/index.js";

describe("protocol messages", () => {
  it("round-trips server diffs with snapshots, removals, and RPC", () => {
    const snapshotBytes = encodeMessage(
      new ComponentSnapshot({ eid: 12, type: 3, payload: Uint8Array.from([1, 2, 3]) })
    );
    const message = new Server2Client({
      diff: new StateDiff({
        fromFrame: 5,
        toFrame: 6,
        snapshots: [snapshotBytes],
        removed: [new RemovedComponent({ eid: 12, type: 4 })],
      }),
      rpc: [new RPC({ rpcId: 0, callId: 9, params: ["ok"] })],
    });

    const decoded = new Decoder(encodeMessage(message)).read(Server2Client);

    expect(decoded.diff?.fromFrame).toBe(5);
    expect(decoded.diff?.toFrame).toBe(6);
    expect(decoded.diff?.removed).toEqual([new RemovedComponent({ eid: 12, type: 4 })]);
    expect(new Decoder(decoded.diff!.snapshots[0]).read(ComponentSnapshot)).toEqual(
      new ComponentSnapshot({ eid: 12, type: 3, payload: Uint8Array.from([1, 2, 3]) })
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
