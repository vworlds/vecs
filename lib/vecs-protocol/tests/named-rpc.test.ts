import { afterEach, describe, expect, it, vi } from "vitest";
import * as vecs from "@vworlds/vecs";
import { Decoder, Encoder } from "@vworlds/vecs-wire";
import { RPC, rpcIdFor, SessionRPC } from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

describe("named RPCs", () => {
  it("uses the shared FNV-1a hash, with the top bit forced, including Unicode names", () => {
    for (const name of ["", "auth", "vecs-mcp/announce", "vecs-mcp/call", "登录/🚀"]) {
      expect(rpcIdFor(name)).toBe((vecs._fnv1a32(name) | 0x80000000) >>> 0);
      expect(rpcIdFor(name)).toBeGreaterThanOrEqual(2 ** 31);
      expect(rpcIdFor(name)).toBeLessThanOrEqual(0xffffffff);
    }
    expect(rpcIdFor("auth")).toBe(0x953fa84f);
  });

  it.each([0, 1, 89, 90, 91, 100, -1, 2 ** 31, 0xffffffff, 2 ** 32, NaN, Infinity, 101.5])(
    "refuses invalid numeric id %s on every API without queuing a call",
    (id) => {
      const rpc = new SessionRPC();
      const handler = () => [];
      expect(() => rpc.listen(id, handler)).toThrow();
      expect(() => rpc.unlisten(id, handler)).toThrow();
      expect(() => rpc.invoke(id)).toThrow();
      expect(rpc.pendingTotal).toBe(0);
    }
  );

  it.each(["auth", "vecs-mcp/call", "", 101, 102, 2 ** 31 - 1])(
    "round-trips %s through the unchanged u32 wire layout and removes by the same key",
    async (name) => {
      const caller = new SessionRPC();
      const peer = new SessionRPC();
      const old = () => "old";
      const replacement = (params: unknown[]) => params;
      peer.listen(name, old);
      peer.listen(name, replacement);
      expect(peer.unlisten(name, old)).toBe(false);
      const call = caller.invoke(name, ["payload"]);
      const encoder = new Encoder(new Uint8Array(1024));
      caller.getOutgoing()[0].wireEncode(encoder);
      peer.process([RPC.wireDecode(new Decoder(encoder.getBuffer()))]);
      await Promise.resolve();
      caller.process(peer.getOutgoing());
      await expect(call).resolves.toMatchObject({ params: ["payload"] });
      expect(peer.unlisten(name, replacement)).toBe(true);
      expect(peer.unlisten(name, replacement)).toBe(false);
      const missing = caller.invoke(name);
      peer.process(caller.getOutgoing());
      caller.process(peer.getOutgoing());
      await expect(missing).rejects.toThrow(
        typeof name === "string" ? JSON.stringify(name) : `Unknown RPC id ${name}`
      );
    }
  );

  it("detects forced collisions across registration, invocation and removal, retaining names", () => {
    vi.spyOn(vecs, "_fnv1a32").mockReturnValue(123);
    const rpc = new SessionRPC();
    const handler = () => [];
    rpc.listen("first", handler);
    expect(() => rpc.listen("second", handler)).toThrow(/"first".*"second"/);
    expect(() => rpc.invoke("second")).toThrow(/"first".*"second"/);
    expect(() => rpc.unlisten("second", handler)).toThrow(/"first".*"second"/);
    expect(rpc.unlisten("first", handler)).toBe(true);
    rpc.abortPending(new Error("reset"));
    expect(() => rpc.listen("second", handler)).toThrow(/"first".*"second"/);
    void rpc.invoke("first");
    expect(rpc.getOutgoing()[0].rpcId).toBe(0x8000007b);
    const invoked = new SessionRPC();
    void invoked.invoke("second");
    expect(() => invoked.listen("first", handler)).toThrow(/"second".*"first"/);
  });

  it("does not hash incoming requests, replies, or retransmissions", async () => {
    const hash = vi.spyOn(vecs, "_fnv1a32");
    const caller = new SessionRPC();
    const peer = new SessionRPC();
    peer.listen("auth", () => "ok");
    const pending = caller.invoke("auth");
    expect(hash).toHaveBeenCalledTimes(2);
    peer.process(caller.getOutgoing());
    await Promise.resolve();
    peer.process(caller.getOutgoing());
    caller.process(peer.getOutgoing());
    await expect(pending).resolves.toMatchObject({ params: ["ok"] });
    expect(hash).toHaveBeenCalledTimes(2);
  });
});
