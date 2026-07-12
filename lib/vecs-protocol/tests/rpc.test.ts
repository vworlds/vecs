import { describe, expect, it } from "vitest";
import {
  FIRST_USER_RPC_ID,
  RPC_RESPONSE_ID,
  SESSION_ENTITY_RPC_ID,
  SessionRPC,
} from "../src/index.js";

describe("SessionRPC id ranges", () => {
  it("invoke rejects reserved system ids", () => {
    const rpc = new SessionRPC();
    expect(() => rpc.invoke(RPC_RESPONSE_ID)).toThrow();
    expect(() => rpc.invoke(SESSION_ENTITY_RPC_ID)).toThrow();
    expect(() => rpc.invoke(FIRST_USER_RPC_ID - 1)).toThrow();
  });

  it("invoke accepts user ids", () => {
    const rpc = new SessionRPC();
    void rpc.invoke(FIRST_USER_RPC_ID).catch(() => undefined);
    expect(rpc.getOutgoing()).toHaveLength(1);
  });

  it("invokeSystem accepts only the reserved system range", () => {
    const rpc = new SessionRPC();
    expect(() => rpc.invokeSystem(RPC_RESPONSE_ID)).toThrow();
    expect(() => rpc.invokeSystem(FIRST_USER_RPC_ID)).toThrow();
    void rpc.invokeSystem(SESSION_ENTITY_RPC_ID).catch(() => undefined);
    expect(rpc.getOutgoing()).toHaveLength(1);
  });
});

describe("system RPC round trip", () => {
  it("resolves an invokeSystem call through listen/process on the other end", async () => {
    const client = new SessionRPC();
    const server = new SessionRPC();
    server.listen(SESSION_ENTITY_RPC_ID, () => [1234]);

    const promise = client.invokeSystem(SESSION_ENTITY_RPC_ID);
    server.process(client.getOutgoing());
    await Promise.resolve(); // request handlers settle on a microtask
    client.process(server.getOutgoing());

    const response = await promise;
    expect(response.rpcId).toBe(RPC_RESPONSE_ID);
    expect(response.error).toBe(0);
    expect(response.params).toEqual([1234]);
  });
});
