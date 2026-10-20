import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { World } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import { ServerWorld } from "@vworlds/vecs-server";
import type { VecsSocket, VecsSocketListener } from "@vworlds/vecs-protocol";
import { VecsMcpServer } from "../../src/server.js";
import { installBridge } from "../../src/client.js";

const cleanups: (() => void | Promise<void>)[] = [];
const registrationQueries = 1;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
class Position {
  x = 1;
}

async function node(name: string, world?: World) {
  const server = new VecsMcpServer({ name });
  if (world) {
    server.registerWorld(world);
  }
  cleanups.push(() => server.close());
  const port = await server.listen(0);
  return { server, port };
}
async function sdk(port: number) {
  const client = new Client({ name: "watch-routing", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  cleanups.push(async () => {
    await transport.terminateSession().catch(() => {});
    await client.close();
  });
  return { client, transport };
}
async function call(client: Client, command: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name: `vecs_${command}`, arguments: args });
  expect(response.isError).not.toBe(true);
  return JSON.parse((response.content as { text: string }[])[0].text);
}
async function denied(client: Client, command: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name: `vecs_${command}`, arguments: args });
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).toContain("Unknown watch");
}
async function paths(client: Client) {
  return (await call(client, "targets")).targets.map((entry: { path: string }) => entry.path);
}

it("routes watch tools and ownership through real peer links, keeping resources local and cleaning up on DELETE", async () => {
  const world = new World();
  world.component(Position);
  const entity = world.entity("sample").add(Position);
  world.flush();
  const baseline = world.queries.length;
  const hook = world.component(Position).meta._onSet;
  const remote = await node("remote", world);
  expect(world.queries.filter((q) => q.name === "vecs-mcp.definitions")).toHaveLength(
    registrationQueries
  );
  const hub = await node("hub");
  hub.server.mount(`ws://127.0.0.1:${remote.port}/link`);
  const a = await sdk(hub.port);
  const b = await sdk(hub.port);
  await expect.poll(() => paths(a.client)).toEqual(["remote/world"]);
  // Omitted target resolves to the peer route and is remembered for cleanup.
  const first = await call(a.client, "watch", { where: "Position", include: ["Position"] });
  const second = await call(b.client, "watch", { target: "remote/world", where: "Position" });
  expect(first.members).toBe(1);
  expect(world.queries.length).toBe(baseline + registrationQueries + 2);
  expect((await a.client.listResources()).resources).toEqual([]);
  await expect(
    a.client.readResource({ uri: `vecs://remote/world/watch/${first.watch}` })
  ).rejects.toThrow("Unknown watch resource");
  await denied(b.client, "events", { target: "remote/world", watch: first.watch });
  await denied(b.client, "unwatch", { target: "remote/world", watch: first.watch });
  entity.set(Position, { x: 9 });
  expect(await call(a.client, "events", { watch: first.watch })).toMatchObject({
    latest: 1,
    dropped: 0,
    events: [{ seq: 1, kind: "update", eid: entity.eid, component: "Position", value: { x: 9 } }],
  });
  await a.transport.terminateSession();
  await expect.poll(() => world.queries.length).toBe(baseline + registrationQueries + 1);
  expect(world.component(Position).meta._onSet).toBe(hook);
  expect(await call(b.client, "events", { watch: second.watch })).toEqual({
    events: [],
    latest: 0,
    dropped: 0,
  });
  await call(b.client, "unwatch", { watch: second.watch });
  expect(world.queries.length).toBe(baseline + registrationQueries);
});

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
class Listener implements VecsSocketListener {
  private _handler!: (socket: VecsSocket) => void;
  public on(_event: "new", handler: (socket: VecsSocket) => void): this {
    this._handler = handler;
    return this;
  }
  public connect(socket: VecsSocket): void {
    this._handler(socket);
  }
}

it("routes watches through a link cascade and the browser wire tunnel with unchanged owners and pull-only reads", async () => {
  const world = new ServerWorld();
  cleanups.push(() => world.dispose());
  const origin = await node("origin", world);
  const listener = new Listener();
  world._attach(listener);
  const serverSocket = new MemorySocket("browser");
  const clientSocket = new MemorySocket("browser");
  serverSocket.peer = clientSocket;
  clientSocket.peer = serverSocket;
  listener.connect(serverSocket);
  const browser = new ClientWorld({ socket: clientSocket });
  cleanups.push(() => browser.dispose());
  browser.component(Position);
  const sample = browser.entity("sample").add(Position);
  installBridge(browser, { readOnly: true });
  let now = 0;
  const timer = setInterval(() => {
    now += 16;
    world.progress(now, 16);
    browser.progress(now, 16);
    browser.send();
  }, 2);
  cleanups.push(() => clearInterval(timer));
  const hub = await node("hub");
  const outer = await node("outer");
  hub.server.mount(`ws://127.0.0.1:${origin.port}/link`);
  outer.server.mount(`ws://127.0.0.1:${hub.port}/link`);
  const a = await sdk(outer.port);
  const b = await sdk(outer.port);
  const target = "hub/origin/main/browser";
  await expect.poll(() => paths(a.client)).toEqual(["hub/origin/main", target]);
  const baseline = browser.queries.length;
  const hook = browser.component(Position).meta._onSet;
  const first = await call(a.client, "watch", { target, where: "Position", include: ["Position"] });
  const second = await call(b.client, "watch", { target, where: "Position" });
  expect(first.members).toBe(1);
  expect(browser.queries.length).toBe(baseline + 2);
  expect((await a.client.listResources()).resources).toEqual([]);
  await expect(
    a.client.subscribeResource({ uri: `vecs://origin/main/watch/${first.watch}` })
  ).rejects.toThrow("Unknown watch resource");
  await denied(b.client, "events", { target, watch: first.watch });
  await denied(b.client, "unwatch", { target, watch: first.watch });
  sample.set(Position, { x: 42 });
  expect(await call(a.client, "events", { target, watch: first.watch })).toMatchObject({
    latest: 1,
    dropped: 0,
    events: [{ seq: 1, kind: "update", eid: sample.eid, component: "Position", value: { x: 42 } }],
  });
  await call(a.client, "unwatch", { target, watch: first.watch });
  expect(browser.queries.length).toBe(baseline + 1);
  expect(browser.component(Position).meta._onSet).toBe(hook);
  await b.transport.terminateSession();
  await expect.poll(() => browser.queries.length).toBe(baseline);
  await denied(a.client, "events", { target, watch: second.watch });
}, 20_000);
