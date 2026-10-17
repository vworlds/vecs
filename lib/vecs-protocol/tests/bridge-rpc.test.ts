import { expect, it } from "vitest";
import { BRIDGE_ANNOUNCE_RPC_ID, BRIDGE_CALL_RPC_ID, SessionRPC } from "../src/index.js";

it("allows only the two bridge exceptions in the reserved request range", () => {
  const rpc = new SessionRPC();
  expect(BRIDGE_ANNOUNCE_RPC_ID).toBe(90);
  expect(BRIDGE_CALL_RPC_ID).toBe(91);
  void rpc.invoke(BRIDGE_ANNOUNCE_RPC_ID);
  void rpc.invoke(BRIDGE_CALL_RPC_ID);
  expect(rpc.pendingCalls).toBe(2);
  expect(rpc.getOutgoing().map((request) => request.rpcId)).toEqual([90, 91]);
  for (const id of [0, 1, 89, 92, 100]) {
    expect(() => rpc.invoke(id)).toThrow("reserved");
  }
});

it("unlisten leaves a replacement callable and removes only the matching reference", async () => {
  const caller = new SessionRPC();
  const peer = new SessionRPC();
  const old = () => "old";
  const replacement = () => "replacement";
  peer.listen(101, old);
  peer.listen(101, replacement);
  expect(peer.unlisten(101, old)).toBe(false);
  const pending = caller.invoke(101);
  peer.process(caller.getOutgoing());
  await Promise.resolve();
  caller.process(peer.getOutgoing());
  await expect(pending).resolves.toMatchObject({ params: ["replacement"] });
  expect(peer.unlisten(101, replacement)).toBe(true);
  expect(peer.unlisten(101, replacement)).toBe(false);
});
