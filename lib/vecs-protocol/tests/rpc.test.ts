import { describe, expect, it } from "vitest";
import {
  FIRST_USER_RPC_ID,
  RPC,
  RPC_CLOSED_CODE,
  RPC_RESPONSE_ID,
  RPC_TIMEOUT_CODE,
  RPC_TIMEOUT_ERROR,
  RPCError,
  SessionRPC,
} from "../src/index.js";

/**
 * Wire two channels together the way a socket pair would: the caller's outbox
 * feeds the responder's inbox, and the responder's outbox feeds the caller's.
 */
function connect(client: SessionRPC, server: SessionRPC): () => void {
  return () => {
    const requests = client.getOutgoing();
    if (requests.length > 0) {
      server.process(requests);
    }
    const replies = server.getOutgoing();
    if (replies.length > 0) {
      client.process(replies);
    }
  };
}

describe("RPCError", () => {
  it("is an Error carrying the code, with error aliasing it", () => {
    const err = new RPCError(4001, "unknown resume token");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RPCError");
    expect(err.message).toBe("unknown resume token");
    expect(err.code).toBe(4001);
    expect(err.error).toBe(4001);
  });

  it("keeps the reserved transport codes distinct from application codes", () => {
    expect(RPC_TIMEOUT_CODE).toBeLessThan(0);
    expect(RPC_CLOSED_CODE).toBeLessThan(0);
    expect(RPC_TIMEOUT_ERROR).toBeInstanceOf(RPCError);
    expect(RPC_TIMEOUT_ERROR.code).toBe(RPC_TIMEOUT_CODE);
    expect(RPC_TIMEOUT_ERROR.message).toBe("Timeout");
  });
});

describe("SessionRPC", () => {
  it("delivers an RPCError code and message to the caller's rejection", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    const pump = connect(client, server);
    server.listen(101, () => {
      throw new RPCError(4001, "unknown resume token");
    });

    const call = client.invoke(101);
    pump();

    await expect(call).rejects.toBeInstanceOf(RPCError);
    await expect(call).rejects.toMatchObject({
      code: 4001,
      error: 4001,
      message: "unknown resume token",
    });
  });

  it("keeps the message of a plain { error, message } rejection", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    const pump = connect(client, server);
    server.listen(101, () => {
      throw { error: 4002, message: "session already bound" };
    });

    const call = client.invoke(101);
    pump();

    await expect(call).rejects.toBeInstanceOf(RPCError);
    await expect(call).rejects.toMatchObject({
      code: 4002,
      message: "session already bound",
    });
  });

  it("serializes a plain rejection that has no message field", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    const pump = connect(client, server);
    server.listen(101, () => {
      throw { error: 4003, detail: "no message field" };
    });

    const call = client.invoke(101);
    pump();

    await expect(call).rejects.toMatchObject({
      code: 4003,
      message: '{"error":4003,"detail":"no message field"}',
    });
  });

  it("falls back to code 1 and the thrown message for an untyped failure", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    const pump = connect(client, server);
    server.listen(101, () => {
      throw new Error("boom");
    });

    const call = client.invoke(101);
    pump();

    await expect(call).rejects.toMatchObject({ code: 1, message: "boom" });
  });

  it("reports an unknown rpc id as code 1 with a readable message", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    const pump = connect(client, server);

    const call = client.invoke(101);
    pump();

    await expect(call).rejects.toMatchObject({
      code: 1,
      message: `Unknown RPC id 101`,
    });
  });

  it("invokes handlers that only declare params and request", async () => {
    const server = new SessionRPC();
    const seen: unknown[][] = [];
    server.listen(101, (params, request) => {
      seen.push([params, request.rpcId]);
      return [42];
    });

    server.process([new RPC({ rpcId: 101, callId: 0, params: ["a"] })]);
    await Promise.resolve();

    expect(seen).toEqual([[["a"], 101]]);
    expect(server.getOutgoing()).toEqual([
      new RPC({ rpcId: RPC_RESPONSE_ID, callId: 0, params: [42] }),
    ]);
  });

  it("rejects reserved call ids without touching the pending map", () => {
    const client = new SessionRPC();

    expect(() => client.invoke(FIRST_USER_RPC_ID - 1)).toThrow(
      `RPC ids 0-${FIRST_USER_RPC_ID - 1} are reserved`
    );
    expect(client.pendingTotal).toBe(0);
  });

  it("rejects pending calls with the given reason and drops the outbox on abortPending", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    server.listen(101, () => []);
    // Queue one queued response so abortPending also has to clear the outbox.
    server.process([new RPC({ rpcId: 101, callId: 7, params: [] })]);
    await Promise.resolve();
    expect(server.pendingTotal).toBe(1);

    const reason = new RPCError(RPC_CLOSED_CODE, "ClientWorld disposed");
    const first = client.invoke(101);
    const second = client.invoke(102);
    expect(client.pendingTotal).toBe(2);

    client.abortPending(reason);

    await expect(first).rejects.toBe(reason);
    await expect(second).rejects.toBe(reason);
    expect(client.pendingTotal).toBe(0);
    expect(client.getOutgoing()).toEqual([]);
  });

  it("ignores a response that arrives after its call was aborted", async () => {
    const client = new SessionRPC();
    const call = client.invoke(101);
    client.abortPending(new RPCError(RPC_CLOSED_CODE, "gone"));
    await expect(call).rejects.toBeInstanceOf(RPCError);

    client.process([new RPC({ rpcId: RPC_RESPONSE_ID, callId: 0, params: ["late"] })]);

    expect(client.pendingTotal).toBe(0);
  });

  it("rejects a timed-out call with RPC_TIMEOUT_ERROR", async () => {
    const client = new SessionRPC(10);
    const call = client.invoke(101);

    client.timeoutTick(10);

    await expect(call).rejects.toBe(RPC_TIMEOUT_ERROR);
    expect(client.pendingTotal).toBe(0);
  });
});
