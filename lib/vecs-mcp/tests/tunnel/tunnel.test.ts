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
  expect(listing.data.targets).toEqual([
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
