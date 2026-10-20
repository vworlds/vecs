import { afterEach, expect, it, vi } from "vitest";
import { ClientWorld } from "@vworlds/vecs-client";
import { ServerWorld } from "@vworlds/vecs-server";
import { World } from "@vworlds/vecs";
import type { VecsSocket, VecsSocketListener } from "@vworlds/vecs-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VecsMcpServer } from "../../src/server.js";
import { installBridge } from "../../src/client.js";
import { Router } from "../../src/bridge/router.js";
import { BridgeClient, dispatchClient } from "../../src/tunnel/index.js";

type Handler = (arg?: unknown) => void;
class MemorySocket implements VecsSocket {
  public peer!: MemorySocket;
  private readonly _handlers = new Map<string, Handler[]>();
  public constructor(public readonly id: string) {}
  public on(event: "connect" | "disconnect" | "receive", handler: Handler): this {
    this._handlers.set(event, [...(this._handlers.get(event) ?? []), handler]);
    return this;
  }
  public send(bytes: Uint8Array): void {
    this.peer._emit("receive", bytes.slice());
  }
  public close(): void {
    this._emit("disconnect");
    this.peer._emit("disconnect");
  }
  private _emit(event: string, value?: unknown): void {
    this._handlers.get(event)?.forEach((handler) => handler(value));
  }
}
class MockListener implements VecsSocketListener {
  private _handler!: (socket: VecsSocket) => void;
  public on(_event: "new", handler: (socket: VecsSocket) => void): this {
    this._handler = handler;
    return this;
  }
  public connect(socket: VecsSocket): void {
    this._handler(socket);
  }
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    await fn();
  }
  vi.useRealTimers();
});

function pair(server: ServerWorld, id: string, bridge = true, readOnly = false) {
  const listener = new MockListener();
  server._attach(listener);
  const a = new MemorySocket(id);
  const b = new MemorySocket(id);
  a.peer = b;
  b.peer = a;
  listener.connect(a);
  const client = new ClientWorld({ socket: b });
  cleanup.push(() => client.dispose());
  if (bridge) {
    installBridge(client, { readOnly });
  }
  class Position {
    x = 1;
  }
  client.component(Position);
  client.entity("sample").add(Position);
  return client;
}

function drive(server: ServerWorld, clients: ClientWorld[]) {
  let now = 0;
  const timer = setInterval(() => {
    now += 16;
    server.progress(now, 16);
    for (const client of clients) {
      client.progress(now, 16);
      client.send();
    }
  }, 2);
  cleanup.push(() => clearInterval(timer));
  return () => clearInterval(timer);
}

it("bounds a client tool by wall clock when the game loop never sends", async () => {
  const server = new ServerWorld();
  cleanup.push(() => server.dispose());
  const router = new Router("node", {});
  router.register(server, "main");
  const client = pair(server, "browser");
  client.send();
  expect(
    router
      .table()
      .targets.filter((target) => target.kind === "client")
      .map((target) => (target.client as { id: string }).id)
  ).toEqual(["browser"]);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let result: unknown;
  const call = router
    .dispatch({
      id: "paused",
      target: "node/main/browser",
      command: "vecs_entity",
      params: { entity: "sample" },
    })
    .then((response) => {
      result = response;
    });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(result).toMatchObject({
    error: { code: "VECS_ERROR", message: "Timeout", hops: ["node", "browser"] },
  });
  await call;
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])("clears the call timer on early settlement (error=%s)", async (fails) => {
  const server = new ServerWorld();
  cleanup.push(() => server.dispose());
  const invoke = vi.spyOn(server, "invoke");
  if (fails) {
    invoke.mockRejectedValue(new Error("gone"));
  } else {
    invoke.mockResolvedValue([{ id: "fast", result: 42 }]);
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const call = dispatchClient(server, "browser", {
      id: "fast",
      command: "vecs_stats",
      params: {},
    });
    if (fails) {
      await expect(call).rejects.toMatchObject({ message: "gone" });
    } else {
      await expect(call).resolves.toBe(42);
    }
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    invoke.mockRestore();
  }
});

it("closes with a tunneled watch open after the game loop stops", async () => {
  const server = new ServerWorld();
  cleanup.push(() => server.dispose());
  const node = new VecsMcpServer({ name: "node" });
  cleanup.push(() => node.close());
  node.registerWorld(server);
  const client = pair(server, "browser");
  const stop = drive(server, [client]);
  const sdk = new Client({ name: "paused-close", version: "1" });
  cleanup.push(() => sdk.close());
  const port = await node.listen(0);
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const call = async (name: string, args = {}) => {
    const response = await sdk.callTool({ name, arguments: args });
    return JSON.parse((response.content as { text: string }[])[0].text);
  };
  await expect
    .poll(
      async () =>
        (await call("vecs_targets")).targets.filter((t: { kind: string }) => t.kind === "client")
          .length
    )
    .toBe(1);
  const watch = await sdk.callTool({
    name: "vecs_watch",
    arguments: { target: "node/main/browser", where: "Position" },
  });
  expect(watch.isError).not.toBe(true);
  expect(JSON.parse((watch.content as { text: string }[])[0].text)).toMatchObject({
    watch: expect.any(String),
    members: 1,
  });
  stop();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let closed = false;
  const closing = node.close().then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(9_999);
  expect(closed).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  // HTTP shutdown still uses real IO; do not virtualize its scheduling.
  vi.useRealTimers();
  await closing;
  expect(closed).toBe(true);
});

it("registers no tunnel component or hook in a plain World", () => {
  const world = new World();
  const router = new Router("node", {});
  router.register(world, "plain");
  expect(world.getEntity(BridgeClient)).toBeUndefined();
  world.dispose();
});

it("lists only announced clients, executes node tools through the tunnel, and removes disconnected targets", async () => {
  const server = new ServerWorld();
  cleanup.push(() => server.dispose());
  const node = new VecsMcpServer({ name: "node" });
  cleanup.push(() => node.close());
  node.registerWorld(server);
  const client = pair(server, "browser");
  const plain = pair(server, "without-bridge", false);
  const readOnly = pair(server, "read-only", true, true);
  drive(server, [client, plain, readOnly]);
  const sdk = new Client({ name: "test", version: "1" });
  cleanup.push(() => sdk.close());
  const port = await node.listen(0);
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const call = async (name: string, args = {}) => {
    const response = await sdk.callTool({ name, arguments: args });
    return {
      error: response.isError === true,
      data: JSON.parse((response.content as { text: string }[])[0].text),
    };
  };
  await expect.poll(async () => (await call("vecs_targets")).data.targets.length).toBe(3);
  const listing = await call("vecs_targets");
  expect(listing.data.targets).toMatchObject([
    expect.objectContaining({ path: "node/main", kind: "world" }),
    {
      path: "node/main/browser",
      kind: "client",
      client: { id: "browser", eid: expect.any(Number) },
    },
    {
      path: "node/main/read-only",
      kind: "client",
      client: { id: "read-only", eid: expect.any(Number) },
    },
  ]);
  const target = "node/main/browser";
  expect(await call("vecs_entity", { target, entity: "sample" })).toMatchObject({
    error: false,
    data: { components: { Position: { x: 1 } } },
  });
  expect(
    await call("vecs_mutate", {
      target,
      ops: [{ set: true, entity: "sample", component: "Position", value: { x: 42 } }],
    })
  ).toMatchObject({ error: false, data: { applied: [{ eid: expect.any(Number) }] } });
  expect(await call("vecs_entity", { target, entity: "sample" })).toMatchObject({
    error: false,
    data: { components: { Position: { x: 42 } } },
  });
  expect(
    await call("vecs_mutate", { target: "node/main/read-only", ops: [{ create: true }] })
  ).toMatchObject({
    error: true,
    data: { hops: ["node", "read-only"], message: expect.stringContaining("readOnly") },
  });
  expect(await call("vecs_entity", { target, entity: "missing" })).toMatchObject({
    error: true,
    data: {
      code: "VECS_ERROR",
      hops: ["node", "browser"],
      message: expect.stringContaining("Unknown entity"),
    },
  });
  client.close();
  expect((await call("vecs_targets")).data.targets.map((t: { path: string }) => t.path)).toEqual([
    "node/main",
    "node/main/read-only",
  ]);
  expect(await call("vecs_entity", { target, entity: "sample" })).toMatchObject({
    error: true,
    data: { message: expect.stringContaining("Unknown target") },
  });
});

it("advertises client lifecycle through a mounting hub and routes client tools and error hops through a cascade", async () => {
  const server = new ServerWorld();
  cleanup.push(() => server.dispose());
  const node = new VecsMcpServer({ name: "node" });
  const hub = new VecsMcpServer({ name: "hub" });
  const outer = new VecsMcpServer({ name: "outer" });
  cleanup.push(
    () => node.close(),
    () => hub.close(),
    () => outer.close()
  );
  node.registerWorld(server);
  const nodePort = await node.listen(0);
  const hubPort = await hub.listen(0);
  const outerPort = await outer.listen(0);
  hub.mount(`ws://127.0.0.1:${nodePort}/link`);
  outer.mount(`ws://127.0.0.1:${hubPort}/link`);
  const connect = async (port: number) => {
    const sdk = new Client({ name: "tunnel-hub-test", version: "1" });
    cleanup.push(() => sdk.close());
    await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    return async (name: string, args = {}) => {
      const result = await sdk.callTool({ name, arguments: args });
      return {
        error: result.isError === true,
        data: JSON.parse((result.content as { text: string }[])[0].text),
      };
    };
  };
  const atHub = await connect(hubPort);
  const atOuter = await connect(outerPort);
  const paths = async (call: typeof atHub) =>
    (await call("vecs_targets")).data.targets.map((entry: { path: string }) => entry.path);
  await expect.poll(() => paths(atHub)).toEqual(["node/main"]);
  await expect.poll(() => paths(atOuter)).toEqual(["hub/node/main"]);
  // Establish a client after link tables have settled. No world/peer changes follow.
  const client = pair(server, "browser", false);
  drive(server, [client]);
  expect(await paths(atHub)).toEqual(["node/main"]);
  installBridge(client);
  await expect.poll(() => paths(atHub)).toEqual(["node/main", "node/main/browser"]);
  await expect.poll(() => paths(atOuter)).toEqual(["hub/node/main", "hub/node/main/browser"]);
  const entries = (await atOuter("vecs_targets")).data.targets;
  expect(entries[1]).toMatchObject({
    path: "hub/node/main/browser",
    kind: "client",
    client: { id: "browser", eid: expect.any(Number) },
    node: { name: "node" },
  });
  expect(
    await atHub("vecs_entity", { target: "node/main/browser", entity: "sample" })
  ).toMatchObject({ error: false, data: { components: { Position: { x: 1 } } } });
  const target = "hub/node/main/browser";
  expect(
    await atOuter("vecs_mutate", {
      target,
      ops: [{ set: true, entity: "sample", component: "Position", value: { x: 42 } }],
    })
  ).toMatchObject({ error: false, data: { applied: [{ eid: expect.any(Number) }] } });
  expect(await atOuter("vecs_entity", { target, entity: "sample" })).toMatchObject({
    error: false,
    data: { components: { Position: { x: 42 } } },
  });
  expect(await atOuter("vecs_entity", { target, entity: "missing" })).toMatchObject({
    error: true,
    data: { code: "VECS_ERROR", hops: ["outer", "hub", "node", "browser"] },
  });
  client.close();
  await expect.poll(() => paths(atHub)).toEqual(["node/main"]);
  await expect.poll(() => paths(atOuter)).toEqual(["hub/node/main"]);
});

it("enforces node readOnly before forwarding a mutation", async () => {
  const server = new ServerWorld();
  cleanup.push(() => server.dispose());
  const router = new Router("node", {}, true);
  router.register(server, "main");
  const client = pair(server, "browser");
  drive(server, [client]);
  await expect.poll(() => router.table().targets.length).toBe(2);
  expect(
    await router.dispatch({
      id: "test",
      target: "node/main/browser",
      command: "vecs_mutate",
      params: { ops: [{ create: true }] },
    })
  ).toMatchObject({ error: { message: expect.stringContaining("readOnly") } });
});
