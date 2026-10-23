import { describe, expect, it, vi } from "vitest";
import {
  FIRST_USER_RPC_ID,
  RPC,
  RPC_CLOSED_CODE,
  RPC_RESPONSE_ID,
  RPC_TIMEOUT_CODE,
  RPC_TIMEOUT_ERROR,
  RPC_UNSPECIFIED_ERROR_CODE,
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

/** A promise the test settles by hand, to hold a handler in flight. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let the continuations of settled handlers run, so the replies they owe are queued. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

const request = (callId: number, ...params: unknown[]) => new RPC({ rpcId: 101, callId, params });
const response = (callId: number, ...params: unknown[]) =>
  new RPC({ rpcId: RPC_RESPONSE_ID, callId, params });

/**
 * The call ids whose replies the channel still caches. Eviction has no other
 * observable effect: a request below the watermark is ignored whether or not
 * its reply is still held, so memory is the only thing the cache can leak.
 */
function cachedCallIds(rpc: SessionRPC): number[] {
  return [...(rpc as unknown as { _cachedReplies: Map<number, RPC> })._cachedReplies.keys()];
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

  it("fails a call whose handler throws a plain Error with the exported RPC_UNSPECIFIED_ERROR_CODE", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    const pump = connect(client, server);
    server.listen(101, () => {
      throw new Error("boom");
    });

    const call = client.invoke(101);
    pump();

    await expect(call).rejects.toBeInstanceOf(RPCError);
    await expect(call).rejects.toMatchObject({
      code: RPC_UNSPECIFIED_ERROR_CODE,
      message: "boom",
    });
    expect(RPC_UNSPECIFIED_ERROR_CODE).toBe(1);
  });

  it("fails a call to an rpc id with no handler with the exported RPC_UNSPECIFIED_ERROR_CODE", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    const pump = connect(client, server);

    const call = client.invoke(101);
    pump();

    await expect(call).rejects.toMatchObject({ code: RPC_UNSPECIFIED_ERROR_CODE });
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

  describe("codes that cannot cross the wire", () => {
    // `RPC.error` is a u32 and `0` means success on the receiving side, so a
    // thrown code of 0 would make the caller's `invoke` resolve as a success.
    const rejected: Array<[label: string, thrown: unknown]> = [
      ["zero", new RPCError(0, "zero")],
      ["negative", new RPCError(-7, "negative")],
      ["the local timeout code", new RPCError(RPC_TIMEOUT_CODE, "timeout")],
      ["the local closed code", new RPCError(RPC_CLOSED_CODE, "closed")],
      ["a plain object with error 0", { error: 0, message: "zero object" }],
      ["a plain object with a negative error", { error: -3, message: "negative object" }],
      ["a non-integer", new RPCError(4001.5, "fractional")],
      ["NaN", new RPCError(Number.NaN, "not a number")],
      ["above 2^32-1", new RPCError(0x1_0000_0000, "too large")],
    ];

    rejected.forEach(([label, thrown]) => {
      it(`sends code 1 for ${label} so the call still fails`, async () => {
        const client = new SessionRPC();
        const server = new SessionRPC();
        const pump = connect(client, server);
        server.listen(101, () => {
          throw thrown;
        });

        const call = client.invoke(101);
        pump();

        await expect(call).rejects.toMatchObject({ code: 1 });
        // Never resolves: the failure has to survive as a rejection.
        await expect(call).rejects.toBeInstanceOf(RPCError);
      });
    });

    it("transmits the top of the valid range unchanged", async () => {
      const client = new SessionRPC();
      const server = new SessionRPC();
      const pump = connect(client, server);
      server.listen(101, () => {
        throw new RPCError(0xffff_ffff, "max");
      });

      const call = client.invoke(101);
      pump();

      await expect(call).rejects.toMatchObject({ code: 0xffff_ffff, message: "max" });
    });

    it("transmits a valid code unchanged", async () => {
      const client = new SessionRPC();
      const server = new SessionRPC();
      const pump = connect(client, server);
      server.listen(101, () => {
        throw new RPCError(1, "lowest valid");
      });

      const call = client.invoke(101);
      pump();

      await expect(call).rejects.toMatchObject({ code: 1, message: "lowest valid" });
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
    const client = new SessionRPC(10, () => 0);
    const call = client.invoke(101);

    client.timeoutTick(10);

    await expect(call).rejects.toBe(RPC_TIMEOUT_ERROR);
    expect(client.pendingTotal).toBe(0);
  });
});

describe("SessionRPC duplicate requests", () => {
  it("runs a handler once for copies that arrive while it is in flight", async () => {
    const server = new SessionRPC();
    const gate = deferred<unknown[]>();
    const handler = vi.fn(() => gate.promise);
    server.listen(101, handler);

    // The caller re-sends its pending request with every frame, so copies keep
    // arriving while the first run is still waiting on something slow.
    server.process([request(0, "spend")]);
    server.process([request(0, "spend")]);
    server.process([request(0, "spend")]);
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(server.getOutgoing()).toEqual([]);

    gate.resolve(["spent"]);
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(server.getOutgoing()).toEqual([response(0, "spent")]);
    expect(server.getOutgoing()).toEqual([]);
  });

  it("runs a handler once for two copies in one process() batch", async () => {
    const server = new SessionRPC();
    const gate = deferred<unknown[]>();
    const handler = vi.fn(() => gate.promise);
    server.listen(101, handler);

    server.process([request(0), request(0)]);
    gate.resolve(["done"]);
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(server.getOutgoing()).toEqual([response(0, "done")]);
  });

  it("answers a copy that arrives after the handler settled with the original reply", async () => {
    const server = new SessionRPC();
    const handler = vi.fn(() => ["spent"]);
    server.listen(101, handler);
    server.process([request(0)]);
    await flush();
    expect(server.getOutgoing()).toEqual([response(0, "spent")]);

    server.process([request(0)]);
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(server.getOutgoing()).toEqual([response(0, "spent")]);
  });

  it("runs a failing handler once and answers every copy with its error", async () => {
    const server = new SessionRPC();
    const gate = deferred<unknown[]>();
    const handler = vi.fn(() => gate.promise);
    server.listen(101, handler);
    const failure = {
      rpcId: RPC_RESPONSE_ID,
      callId: 0,
      error: 4001,
      message: "unknown resume token",
    };

    server.process([request(0)]);
    server.process([request(0)]);
    gate.reject(new RPCError(4001, "unknown resume token"));
    await flush();
    expect(server.getOutgoing()).toMatchObject([failure]);

    server.process([request(0)]);
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(server.getOutgoing()).toMatchObject([failure]);
  });

  it("answers every copy of a call to an unknown rpc id with the same error", async () => {
    const server = new SessionRPC();
    const unknown = {
      rpcId: RPC_RESPONSE_ID,
      callId: 0,
      error: 1,
      message: "Unknown RPC id 999",
    };
    server.process([new RPC({ rpcId: 999, callId: 0 })]);
    await flush();
    expect(server.getOutgoing()).toMatchObject([unknown]);

    // The call was answered; a handler registered afterwards does not reopen it.
    const handler = vi.fn(() => ["too late"]);
    server.listen(999, handler);
    server.process([new RPC({ rpcId: 999, callId: 0 })]);
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(server.getOutgoing()).toMatchObject([unknown]);
  });
});

describe("SessionRPC peer watermark", () => {
  it("ignores a request below the watermark: no handler run and no reply", async () => {
    const server = new SessionRPC();
    const handler = vi.fn(() => ["ok"]);
    server.listen(101, handler);
    server.setPeerSettledBelow(5);

    server.process([request(0), request(4)]);
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(server.getOutgoing()).toEqual([]);
    expect(server.pendingTotal).toBe(0);
  });

  it("treats a call at the watermark as live", async () => {
    const server = new SessionRPC();
    const handler = vi.fn(() => ["ok"]);
    server.listen(101, handler);
    server.setPeerSettledBelow(5);

    server.process([request(5)]);
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(server.getOutgoing()).toEqual([response(5, "ok")]);
  });

  it("evicts cached and unsent replies below a raised watermark and keeps the rest", async () => {
    const server = new SessionRPC();
    const handler = vi.fn((params: unknown[]) => params);
    server.listen(101, handler);
    server.process([request(0, "a"), request(1, "b"), request(2, "c"), request(3, "d")]);
    await flush();
    expect(cachedCallIds(server)).toEqual([0, 1, 2, 3]);

    server.setPeerSettledBelow(2);

    expect(cachedCallIds(server)).toEqual([2, 3]);
    // The replies still waiting to be sent for calls 0 and 1 are dropped with them.
    expect(server.getOutgoing()).toEqual([response(2, "c"), response(3, "d")]);
    // A copy at or above the watermark still gets its cached reply.
    server.process([request(3, "d")]);
    await flush();
    expect(handler).toHaveBeenCalledTimes(4);
    expect(server.getOutgoing()).toEqual([response(3, "d")]);
  });

  it("evicts the cached error reply of an unknown rpc id like any other reply", async () => {
    const server = new SessionRPC();
    server.process([new RPC({ rpcId: 999, callId: 0 })]);
    await flush();
    expect(cachedCallIds(server)).toEqual([0]);

    server.setPeerSettledBelow(1);

    expect(cachedCallIds(server)).toEqual([]);
  });

  it("never moves the watermark backwards", async () => {
    const server = new SessionRPC();
    const handler = vi.fn(() => ["ok"]);
    server.listen(101, handler);
    server.setPeerSettledBelow(5);

    server.setPeerSettledBelow(3); // a late frame that carries an older watermark
    server.setPeerSettledBelow(5);
    server.process([request(4)]);
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(server.getOutgoing()).toEqual([]);
  });

  it("discards the reply of a handler the watermark passed while it was running", async () => {
    const server = new SessionRPC();
    const gate = deferred<unknown[]>();
    const handler = vi.fn(() => gate.promise);
    server.listen(101, handler);
    server.process([request(0)]);

    server.setPeerSettledBelow(1); // the caller gave up on call 0
    gate.resolve(["too late"]);
    await flush();

    expect(server.getOutgoing()).toEqual([]);
    expect(cachedCallIds(server)).toEqual([]);
    server.process([request(0)]); // a straggling copy
    await flush();
    expect(handler).toHaveBeenCalledOnce();
    expect(server.getOutgoing()).toEqual([]);
  });

  it("evicts a reply once the caller's next frame reports the call settled", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    server.listen(101, () => ["pong"]);
    // What a bare pair of channels has to do for each frame it exchanges.
    const exchange = (): void => {
      server.setPeerSettledBelow(client.settledBelow);
      server.process(client.getOutgoing());
      client.setPeerSettledBelow(server.settledBelow);
      client.process(server.getOutgoing());
    };

    const call = client.invoke(101);
    exchange(); // the request reaches the server
    await flush();
    exchange(); // the reply reaches the client
    await expect(call).resolves.toMatchObject({ params: ["pong"] });
    // The server cannot tell the reply arrived, so it keeps it ...
    expect(cachedCallIds(server)).toEqual([0]);

    exchange(); // ... until the caller's next frame says call 0 has settled

    expect(cachedCallIds(server)).toEqual([]);
  });
});

describe("SessionRPC.settledBelow", () => {
  it("starts at 0", () => {
    expect(new SessionRPC().settledBelow).toBe(0);
  });

  it("stays at the lowest pending call while replies arrive out of order", async () => {
    const client = new SessionRPC();
    const calls = [client.invoke(101), client.invoke(101), client.invoke(101)];
    expect(client.settledBelow).toBe(0);

    client.process([response(1)]);
    expect(client.settledBelow).toBe(0);

    client.process([response(0)]);
    expect(client.settledBelow).toBe(2);

    client.process([response(2)]);
    expect(client.settledBelow).toBe(3);
    await Promise.all(calls);
  });

  it("advances through calls that time out or are aborted", async () => {
    const client = new SessionRPC(5000, () => 0);
    const reason = new RPCError(RPC_CLOSED_CODE, "peer gone");
    const outcomes = [
      client.invoke(101, [], 10),
      client.invoke(101, [], 1000),
      client.invoke(101, [], 1000),
    ].map((call) => call.catch((error: unknown) => error));

    client.timeoutTick(10); // call 0 times out
    expect(client.settledBelow).toBe(1);

    client.process([response(2)]); // call 2 is answered, but call 1 is still waiting
    expect(client.settledBelow).toBe(1);

    client.abortPending(reason); // call 1 is aborted
    expect(client.settledBelow).toBe(3);

    expect(await outcomes[0]).toBe(RPC_TIMEOUT_ERROR);
    expect(await outcomes[1]).toBe(reason);
  });

  it("keeps counting from the next call id after an abort", async () => {
    const client = new SessionRPC();
    void client.invoke(101).catch(() => undefined);
    client.abortPending(new RPCError(RPC_CLOSED_CODE, "peer gone"));
    expect(client.settledBelow).toBe(1);

    const next = client.invoke(101);
    expect(client.settledBelow).toBe(1);
    client.process([response(1)]);
    await next;
    expect(client.settledBelow).toBe(2);
  });
});

describe("SessionRPC.timeoutTick", () => {
  it("expires at an absolute deadline, never charging repeated ticks or pre-call time", async () => {
    let now = 50_000;
    const channel = new SessionRPC(10_000, () => now);
    const outcomes: number[] = [];
    const first = channel.invoke(101).catch((error) => {
      outcomes.push(0);
      return error;
    });
    now = 55_000;
    const second = channel.invoke(101).catch((error) => {
      outcomes.push(1);
      return error;
    });
    channel.timeoutTick(59_999);
    channel.timeoutTick(59_999);
    await flush();
    expect(outcomes).toEqual([]);
    expect(channel.pendingCalls).toBe(2);
    channel.timeoutTick(60_000);
    expect(await first).toBe(RPC_TIMEOUT_ERROR);
    expect(channel.settledBelow).toBe(1);
    expect(channel.getOutgoing().map((rpc) => rpc.callId)).toEqual([1]);
    channel.timeoutTick(65_001);
    expect(await second).toBe(RPC_TIMEOUT_ERROR);
    expect(outcomes).toEqual([0, 1]);
    expect(channel.settledBelow).toBe(2);
  });

  it("rejects expired calls in call-id order even with different deadlines", async () => {
    const channel = new SessionRPC(5000, () => 100);
    const order: number[] = [];
    const calls = [30, 10, 20].map((ttl, id) =>
      channel.invoke(101, [], ttl).catch((error) => {
        order.push(id);
        return error;
      })
    );
    channel.timeoutTick(130);
    expect(await Promise.all(calls)).toEqual(Array(3).fill(RPC_TIMEOUT_ERROR));
    expect(order).toEqual([0, 1, 2]);
    expect(channel.settledBelow).toBe(3);
  });

  it("rejects pending calls but no longer evicts cached replies", async () => {
    const channel = new SessionRPC(10, () => 0);
    const handler = vi.fn(() => ["once"]);
    channel.listen(101, handler);
    channel.process([request(0)]);
    await flush();
    expect(channel.getOutgoing()).toEqual([response(0, "once")]);
    const pending = channel.invoke(102);

    channel.timeoutTick(1_000_000);

    await expect(pending).rejects.toBe(RPC_TIMEOUT_ERROR);
    // A copy that turns up long after the old time-to-live still gets the original reply.
    channel.process([request(0)]);
    await flush();
    expect(handler).toHaveBeenCalledOnce();
    expect(channel.getOutgoing()).toEqual([response(0, "once")]);
  });
});

describe("SessionRPC.abortPending forgets the peer", () => {
  const gone = () => new RPCError(RPC_CLOSED_CODE, "peer gone");

  it("runs a new peer's call 0 instead of replaying the old peer's cached reply", async () => {
    const server = new SessionRPC();
    const handler = vi.fn((params: unknown[]) => params);
    server.listen(101, handler);
    server.process([request(0, "old peer")]);
    await flush();
    server.getOutgoing();

    server.abortPending(gone());
    server.process([request(0, "new peer")]);
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(server.getOutgoing()).toEqual([response(0, "new peer")]);
  });

  it("resets the peer watermark to 0", async () => {
    const server = new SessionRPC();
    const handler = vi.fn(() => ["ok"]);
    server.listen(101, handler);
    server.setPeerSettledBelow(7);

    server.abortPending(gone());
    server.process([request(3)]); // stale under the old peer's watermark, live for the new one
    await flush();

    expect(handler).toHaveBeenCalledOnce();
    expect(server.getOutgoing()).toEqual([response(3, "ok")]);
  });

  it("queues nothing for a handler that was running across the abort", async () => {
    const server = new SessionRPC();
    const gate = deferred<unknown[]>();
    server.listen(101, () => gate.promise);
    server.process([request(0)]);

    server.abortPending(gone());
    gate.resolve(["from the old peer's run"]);
    await flush();

    expect(server.getOutgoing()).toEqual([]);
    expect(cachedCallIds(server)).toEqual([]);
  });

  it("keeps the new peer's call in flight when an aborted handler finishes", async () => {
    const server = new SessionRPC();
    const oldRun = deferred<unknown[]>();
    const newRun = deferred<unknown[]>();
    const handler = vi
      .fn<(params: unknown[]) => Promise<unknown[]>>()
      .mockReturnValueOnce(oldRun.promise)
      .mockReturnValueOnce(newRun.promise);
    server.listen(101, handler);
    server.process([request(0)]); // the old peer's call 0

    server.abortPending(gone());
    server.process([request(0)]); // the new peer's call 0 shares its id
    oldRun.resolve(["old"]);
    await flush();
    server.process([request(0)]); // a copy of the new peer's call: its run is still in flight
    await flush();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(server.getOutgoing()).toEqual([]);

    newRun.resolve(["new"]);
    await flush();
    expect(server.getOutgoing()).toEqual([response(0, "new")]);
  });
});
