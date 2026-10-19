import { afterEach, expect, it } from "vitest";
import { ClientWorld } from "@vworlds/vecs-client";
import { ServerWorld } from "@vworlds/vecs-server";
import { World } from "@vworlds/vecs";
import type { VecsSocket, VecsSocketListener } from "@vworlds/vecs-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VecsMcpServer } from "../../src/server.js";
import { installBridge } from "../../src/client.js";
import { Router } from "../../src/bridge/router.js";
import { BridgeClient, clientTargets } from "../../src/tunnel/index.js";

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
}

it("registers no tunnel component or hook in a plain World", () => {
  const world = new World();
  const router = new Router("node", {});
  router.register(world, "plain");
  expect(world.getEntity(BridgeClient)).toBeUndefined();
  world.dispose();
});

it.each(["unregister", "close"])(
  "%s restores tunnel hook and RPC handler counts",
  async (action) => {
    const world = new ServerWorld();
    cleanup.push(() => world.dispose());
    const component = world.component(BridgeClient);
    const count = (slot: unknown) =>
      (slot as { handlers?: unknown[] } | undefined)?.handlers?.length ?? (slot ? 1 : 0);
    const handlers = (world as unknown as { _rpcHandlers: Map<number, unknown> })._rpcHandlers;
    const baseline = [count(component.meta._onAdd), count(component.meta._onRemove), handlers.size];
    const node = new VecsMcpServer({ name: "lifecycle" });
    cleanup.push(() => node.close());
    for (let i = 0; i < 3; i++) {
      node.registerWorld(world);
      expect([
        count(component.meta._onAdd),
        count(component.meta._onRemove),
        handlers.size,
      ]).toEqual(baseline.map((n) => n + 1));
      node.registerWorld(world, "alias");
      expect([
        count(component.meta._onAdd),
        count(component.meta._onRemove),
        handlers.size,
      ]).toEqual([baseline[0] + 2, baseline[1] + 2, baseline[2] + 1]);
      if (action === "close") {
        await node.close();
      } else {
        await node.unregisterWorld(world);
      }
      expect([
        count(component.meta._onAdd),
        count(component.meta._onRemove),
        handlers.size,
      ]).toEqual(baseline);
    }
  }
);

it("unregisters tunneled watches before removing client routes", async () => {
  const world = new ServerWorld();
  cleanup.push(() => world.dispose());
  const node = new VecsMcpServer({ name: "node" });
  cleanup.push(() => node.close());
  node.registerWorld(world);
  const client = pair(world, "browser");
  drive(world, [client]);
  await expect.poll(() => clientTargets(world).length).toBe(1);
  const sdk = new Client({ name: "test", version: "1" });
  cleanup.push(() => sdk.close());
  const port = await node.listen(0);
  await sdk.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const baseline = client.queries.length;
  const response = await sdk.callTool({
    name: "vecs_watch",
    arguments: { target: "node/main/browser", where: "Position" },
  });
  expect(response.isError).not.toBe(true);
  expect(client.queries.length).toBe(baseline + 1);
  await node.unregisterWorld(world);
  expect(client.queries.length).toBe(baseline);
  const targets = await sdk.callTool({ name: "vecs_targets", arguments: {} });
  expect(JSON.parse((targets.content as { text: string }[])[0].text).targets).toEqual([]);
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
  await expect.poll(() => clientTargets(server).length).toBe(2);
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
  await expect.poll(() => clientTargets(server).length).toBe(1);
  expect(
    await router.dispatch({
      id: "test",
      target: "node/main/browser",
      command: "vecs_mutate",
      params: { ops: [{ create: true }] },
    })
  ).toMatchObject({ error: { message: expect.stringContaining("readOnly") } });
});
