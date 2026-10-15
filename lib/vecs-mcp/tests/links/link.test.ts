import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocket as Ws, WebSocketServer } from "ws";
import { World } from "@vworlds/vecs";
import { VecsMcpServer } from "../../src/index.js";
import { Router } from "../../src/bridge/router.js";
import { Link } from "../../src/links/link.js";

const servers: VecsMcpServer[] = [];
const clients: Client[] = [];
const cleanup: (() => void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  cleanup.splice(0).forEach((close) => close());
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function node(name: string, token?: string, port = 0) {
  const server = new VecsMcpServer({ name, token });
  servers.push(server);
  const bound = await server.listen(port);
  return {
    server,
    port: bound,
    link: `ws://127.0.0.1:${bound}/link`,
    url: new URL(`http://127.0.0.1:${bound}/mcp`),
  };
}

function world() {
  class Position {
    x = 1;
  }
  const world = new World();
  world.component(Position);
  world.entity("sample").add(Position);
  world.system("move").run(() => {});
  return world;
}

async function connect(url: URL, token?: string) {
  const client = new Client({ name: "links-test", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    })
  );
  return client;
}

async function call(client: Client, command: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name: `vecs_${command}`, arguments: args });
  const value = JSON.parse((response.content as { text: string }[])[0].text);
  return { error: response.isError === true, value };
}

async function paths(client: Client): Promise<string[]> {
  return (await call(client, "targets")).value.targets.map((entry: { path: string }) => entry.path);
}

async function linked(link: Link) {
  await vi.waitFor(() => expect(link.state).toBe("linked"));
}

describe("links through MCP", () => {
  it("joins two nodes, preserves metadata and routes every tool by path", async () => {
    const hub = await node("hub");
    const a = await node("a");
    const b = await node("b");
    a.server.registerWorld(world());
    b.server.registerWorld(world());
    await Promise.all([linked(a.server.join(hub.link)), linked(b.server.join(hub.link))]);
    const client = await connect(hub.url);
    await vi.waitFor(async () =>
      expect((await paths(client)).sort()).toEqual(["a/world", "b/world"])
    );
    const targets = (await call(client, "targets")).value.targets;
    const origin = (await call(await connect(a.url), "targets")).value.node;
    expect(origin).toMatchObject({ name: "a", pid: process.pid, cwd: process.cwd() });
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "a/world",
          node: origin,
          via: [expect.any(String)],
        }),
      ])
    );
    for (const target of ["a/world", "b/world"]) {
      expect(await call(client, "components", { target, filter: "Position" })).toMatchObject({
        error: false,
        value: [{ name: "Position" }],
      });
      expect(await call(client, "find", { target, where: "Position" })).toMatchObject({
        error: false,
        value: { total: 1 },
      });
      expect(await call(client, "entity", { target, entity: "sample" })).toMatchObject({
        error: false,
        value: { name: "sample", components: { Position: { x: 1 } } },
      });
      expect(
        await call(client, "mutate", {
          target,
          ops: [{ set: true, entity: "sample", component: "Position", value: { x: 7 } }],
        })
      ).toMatchObject({ error: false, value: { applied: [{ eid: expect.any(Number) }] } });
      expect(await call(client, "entity", { target, entity: "sample" })).toMatchObject({
        value: { components: { Position: { x: 7 } } },
      });
      expect(await call(client, "systems", { target, disable: "move" })).toMatchObject({
        error: false,
        value: [{ name: "move", enabled: false }],
      });
      expect(await call(client, "stats", { target })).toMatchObject({
        error: false,
        value: { systems: [{ name: "move", runs: 0 }], operations: [] },
      });
    }
    expect(await call(client, "stats")).toMatchObject({
      error: true,
      value: { message: "Specify target; available targets: a/world, b/world", hops: ["hub"] },
    });
  });

  it("mounts in the reverse direction, cascades two hops and propagates errors", async () => {
    const hub = await node("hub");
    const middle = await node("middle");
    const leaf = await node("leaf");
    leaf.server.registerWorld(world());
    await linked(middle.server.mount(leaf.link));
    await linked(hub.server.mount(middle.link));
    const client = await connect(hub.url);
    await vi.waitFor(async () => expect(await paths(client)).toEqual(["middle/leaf/world"]));
    expect(
      await call(client, "find", { target: "middle/leaf/world", where: "Position" })
    ).toMatchObject({ error: false, value: { total: 1 } });
    expect(
      await call(client, "entity", { target: "middle/leaf/world", entity: "absent" })
    ).toMatchObject({
      error: true,
      value: { code: "VECS_ERROR", hops: ["hub", "middle", "leaf"] },
    });
    expect((await call(client, "targets")).value.targets[0]).toMatchObject({
      node: { name: "leaf" },
      via: [expect.any(String), expect.any(String)],
    });
    await leaf.server.close();
    await vi.waitFor(async () => expect(await paths(client)).toEqual([]));
  });

  it("drops cyclic advertisements rather than growing paths", async () => {
    const a = await node("a");
    const b = await node("b");
    a.server.registerWorld(world());
    b.server.registerWorld(world());
    const ab = a.server.mount(b.link);
    const ba = b.server.mount(a.link);
    await Promise.all([linked(ab), linked(ba)]);
    const ca = await connect(a.url);
    const cb = await connect(b.url);
    await vi.waitFor(async () => {
      expect(await paths(ca)).toEqual(["a/world", "b/world"]);
      expect(await paths(cb)).toEqual(["b/world", "a/world"]);
    });
    expect(await call(ca, "find", { target: "b/world", where: "Position" })).toMatchObject({
      error: false,
      value: { total: 1 },
    });
    // A later topology change traverses the cycle but still leaves only simple paths.
    b.server.registerWorld(new World(), "second");
    await vi.waitFor(async () =>
      expect(await paths(ca)).toEqual(["a/world", "b/world", "b/second"])
    );
    expect(ab.state).toBe("linked");
    expect(ba.state).toBe("linked");
  });

  it("refreshes after registration, removes on close, reconnects, and cancels retries", async () => {
    const hub = await node("hub");
    const game = await node("game");
    const link = game.server.join(hub.link);
    await linked(link);
    const client = await connect(hub.url);
    expect(await paths(client)).toEqual([]);
    game.server.registerWorld(world());
    await vi.waitFor(async () => expect(await paths(client)).toEqual(["game/world"]));
    await hub.server.close();
    await vi.waitFor(() => expect(link.state).toBe("backoff"));
    await hub.server.listen(hub.port);
    await vi.waitFor(() => expect(link.state).toBe("linked"), { timeout: 3000 });
    const reconnected = await connect(hub.url);
    await vi.waitFor(async () => expect(await paths(reconnected)).toEqual(["game/world"]));
    link.close();
    link.close();
    await vi.waitFor(async () => expect(await paths(reconnected)).toEqual([]));
    expect(link.state).toBe("closed");
    const failing = game.server.mount("not a URL");
    expect(failing.state).toBe("backoff");
    failing.close();
    expect(failing.state).toBe("closed");
  });

  it("rejects duplicate/local names and incorrect tokens without disturbing existing peers", async () => {
    const hub = await node("hub", "secret");
    const a = await node("game", "secret");
    a.server.registerWorld(world());
    const good = a.server.join(hub.link);
    await linked(good);
    for (const [name, token] of [
      ["game", "secret"],
      ["hub", "secret"],
      ["wrong", "no"],
      ["absent", undefined],
    ]) {
      const other = await node(name!, token);
      const bad = other.server.join(hub.link);
      await vi.waitFor(() => expect(bad.state).toBe("backoff"));
      bad.close();
    }
    const client = await connect(hub.url, "secret");
    expect(await paths(client)).toEqual(["game/world"]);
    expect(good.state).toBe("linked");
  });

  it("retries a refused connection with a short internal backoff", async () => {
    const hub = await node("hub");
    await hub.server.close();
    const router = new Router("game", { name: "game" });
    router.register(world(), "world");
    const link = new Link(router, undefined, { url: hub.link, role: "join" }, { backoff: 10 });
    cleanup.push(() => link.close());
    await vi.waitFor(() => expect(["backoff", "connecting"]).toContain(link.state));
    await hub.server.listen(hub.port);
    await linked(link);
    const client = await connect(hub.url);
    await vi.waitFor(async () => expect(await paths(client)).toEqual(["game/world"]));
  });
});

describe("wire boundaries", () => {
  it.each([
    "wrong node",
    "wrong path",
    "wrong via",
    "duplicate path",
    "wrong direction",
    "invalid response",
  ])("closes a linked peer on %s", (scenario) => {
    const router = new Router("hub", {});
    const link = new Link(router);
    cleanup.push(() => link.close());
    link._attach({ send: () => {}, close: () => link._disconnected() });
    link._receive(
      JSON.stringify({ type: "hello", protocol: 1, role: "join", name: "game", nodeId: "id" })
    );
    expect(link.state).toBe("linked");
    const node = { name: "game", nodeId: "id" };
    const target = { path: "game/world", kind: "world", node, via: ["id"] };
    const frame =
      scenario === "wrong direction"
        ? { type: "request", id: "1", target: "game/world", command: "vecs_stats", params: {} }
        : scenario === "invalid response"
          ? { type: "response", id: "1" }
          : {
              type: "advertise",
              node: scenario === "wrong node" ? { ...node, name: "other" } : node,
              targets:
                scenario === "duplicate path"
                  ? [target, target]
                  : [
                      {
                        ...target,
                        ...(scenario === "wrong path" ? { path: "other/world" } : {}),
                        ...(scenario === "wrong via" ? { via: ["other-id"] } : {}),
                      },
                    ],
            };
    link._receive(JSON.stringify(frame));
    expect(link.state).toBe("closed");
    expect(router.table().targets).toEqual([]);
    expect([...router.destinations.keys()]).toEqual(["hub"]);
  });

  it.each([
    "not-json",
    JSON.stringify({ type: "hello", protocol: 2 }),
    JSON.stringify({
      type: "request",
      id: "x",
      target: "a/world",
      command: "vecs_stats",
      params: {},
    }),
  ])("closes malformed or out-of-state inbound frames: %s", async (frame) => {
    const hub = await node("hub");
    const socket = new Ws(hub.link);
    cleanup.push(() => socket.terminate());
    await new Promise<void>((resolve) => socket.once("open", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.send(frame);
    await closed;
  });

  it("times out forwarded requests with hops and rejects pending requests on loss", async () => {
    const router = new Router("hub", { name: "hub" });
    const link = new Link(router, undefined, undefined, { timeout: 30 });
    cleanup.push(() => link.close());
    link._attach({ send: () => {}, close: () => link._disconnected() });
    link._receive(
      JSON.stringify({ type: "hello", protocol: 1, role: "join", name: "game", nodeId: "game-id" })
    );
    link._receive(
      JSON.stringify({
        type: "advertise",
        node: { name: "game", nodeId: "game-id" },
        targets: [
          {
            path: "game/world",
            kind: "world",
            node: { name: "game", nodeId: "game-id" },
            via: ["game-id"],
          },
        ],
      })
    );
    vi.useFakeTimers();
    const request = { id: "test", target: "game/world", command: "vecs_stats", params: {} };
    const pending = router.dispatch(request);
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toEqual({
      id: "test",
      error: { code: "TIMEOUT", message: "Forwarded request timed out", hops: ["hub"] },
    });
    const interrupted = router.dispatch(request);
    link._disconnected();
    expect(await interrupted).toEqual({
      id: "test",
      error: { code: "LINK_CLOSED", message: "Link closed", hops: ["hub"] },
    });
    expect(router.table().targets).toEqual([]);
  });

  it("native connector rejects malformed listener frames", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    cleanup.push(() => {
      for (const ws of server.clients) {
        ws.terminate();
      }
      server.close();
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => socket.send(JSON.stringify({ type: "welcome", name: 5 })));
    const router = new Router("game", {});
    const port = (server.address() as { port: number }).port;
    const link = new Link(router, undefined, { url: `ws://127.0.0.1:${port}`, role: "mount" });
    cleanup.push(() => link.close());
    await vi.waitFor(() => expect(link.state).toBe("backoff"));
  });
});
