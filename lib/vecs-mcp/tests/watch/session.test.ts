import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { World } from "@vworlds/vecs";
import { VecsMcpServer } from "../../src/server.js";
import { WATCH_IDLE_MS } from "../../src/bridge/watch.js";
import { Router } from "../../src/bridge/router.js";

const servers: VecsMcpServer[] = [];
const transports: StreamableHTTPClientTransport[] = [];
const clients: Client[] = [];
// Each registered world owns one schema query, independently of session watches.
const registrationQueries = 1;
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    transports.splice(0).map((transport) => transport.terminateSession().catch(() => {}))
  );
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
class Position {
  x = 1;
}
async function setup(token?: string) {
  const world = new World();
  const component = world.component(Position);
  const entity = world.entity("sample").add(Position);
  world.flush();
  const baseline = world.queries.length;
  const hook = component.meta._onSet;
  const server = new VecsMcpServer({ name: "sessions", readOnly: true, token });
  servers.push(server);
  server.registerWorld(world);
  expect(world.queries.filter((q) => q.name === "vecs-mcp.definitions")).toHaveLength(
    registrationQueries
  );
  expect(world.queries.length).toBe(baseline + registrationQueries);
  const port = await server.listen(0);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  async function connect() {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    transports.push(transport);
    const client = new Client({ name: "test", version: "1" });
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  }
  return { world, entity, component, baseline, hook, server, url, connect };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name: `vecs_${name}`, arguments: args });
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0].text);
}

describe("session watches and MCP resources", () => {
  it("does not enumerate paths for explicit-target watch tools", async () => {
    const register = vi.spyOn(Router.prototype, "register");
    try {
      const { connect } = await setup();
      const router = register.mock.contexts[0] as Router;
      const paths = vi.spyOn(router.destinations.get("sessions")!, "paths");
      const { client } = await connect();
      const target = "sessions/world";
      const { watch } = await call(client, "watch", { target, where: "Position" });
      await call(client, "events", { target, watch });
      await call(client, "unwatch", { target, watch });
      expect(paths).not.toHaveBeenCalled();
      paths.mockRestore();
    } finally {
      register.mockRestore();
    }
  });

  it("allows 32 watches per session and exposes only the caller's ids at the cap", async () => {
    const { connect } = await setup();
    const a = await connect();
    const b = await connect();
    const own: string[] = [];
    const other: string[] = [];
    for (let i = 0; i < 32; i++) {
      own.push((await call(a.client, "watch", { where: "Position" })).watch);
      other.push((await call(b.client, "watch", { where: "Position" })).watch);
    }
    const rejected = await a.client.callTool({ name: "vecs_watch", arguments: { where: true } });
    expect(rejected.isError).toBe(true);
    const error = JSON.parse((rejected.content as { text: string }[])[0].text);
    expect(error.message).toBe(`Watch cap (32); live ids: ${own.join(", ")}`);
    expect((await b.client.listResources()).resources).toHaveLength(other.length);
    await call(a.client, "unwatch", { watch: own[0] });
    await call(a.client, "watch", { where: "Position" });
  });

  it("evicts the longest-idle session at the 16-session cap and releases its watches", async () => {
    const { connect, url, world, baseline } = await setup();
    const first = await connect();
    const oldest = await connect();
    await call(oldest.client, "watch", { where: "Position" });
    for (let i = 2; i < 16; i++) {
      await connect();
    }
    await call(first.client, "stats");
    await connect();
    expect(world.queries.length).toBe(baseline + registrationQueries);
    expect(
      (
        await fetch(url, {
          method: "DELETE",
          headers: { "mcp-session-id": oldest.transport.sessionId! },
        })
      ).status
    ).toBe(404);
    expect(await call(first.client, "stats")).toHaveProperty("systems");
  });

  it("unregisters resources and subscriptions before re-registering the same world", async () => {
    const { connect, server, world, baseline, component, hook } = await setup();
    const { client } = await connect();
    await call(client, "watch", { where: "Position", include: ["Position"] });
    const uri = (await client.listResources()).resources[0].uri;
    await client.subscribeResource({ uri });
    await server.unregisterWorld(world);
    await server.unregisterWorld(world);
    expect(world.queries.length).toBe(baseline);
    expect(component.meta._onSet).toBe(hook);
    expect((await client.listResources()).resources).toEqual([]);
    expect(await call(client, "targets")).toMatchObject({ targets: [] });
    server.registerWorld(world);
    await call(client, "watch", { where: "Position", include: ["Position"] });
    await server.close();
    expect(world.queries.length).toBe(baseline);
    expect(component.meta._onSet).toBe(hook);
  });

  it("rejects initialization when all 16 sessions have commands in flight", async () => {
    const { connect } = await setup();
    const sessions = [];
    for (let i = 0; i < 16; i++) {
      sessions.push(await connect());
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let ready!: () => void;
    const allEntered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const original = Router.prototype.dispatch;
    const spy = vi.spyOn(Router.prototype, "dispatch").mockImplementation(async function (
      this: Router,
      request
    ) {
      if (request.command === "vecs_stats") {
        if (++entered === 16) {
          ready();
        }
        await gate;
      }
      return original.call(this, request);
    });
    const requests = sessions.map(({ client }) => call(client, "stats"));
    try {
      await allEntered;
      await expect(connect()).rejects.toThrow("MCP session cap (16); all sessions are busy");
    } finally {
      release();
      await Promise.all(requests);
      spy.mockRestore();
    }
    for (const { client } of sessions) {
      expect(await call(client, "stats")).toHaveProperty("systems");
    }
  });

  it("reserves capacity for 16 pending initializations", async () => {
    const { connect } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready!: () => void;
    const allEntered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let entered = 0;
    const original = McpServer.prototype.connect;
    const spy = vi.spyOn(McpServer.prototype, "connect").mockImplementation(async function (
      this: McpServer,
      transport
    ) {
      if (++entered === 16) {
        ready();
      }
      await gate;
      return original.call(this, transport);
    });
    const pending = Array.from({ length: 16 }, () => connect());
    try {
      await allEntered;
      await expect(connect()).rejects.toThrow("MCP session cap (16); all sessions are busy");
    } finally {
      release();
      await Promise.all(pending);
      spy.mockRestore();
    }
  });

  it("retains each remote route when different worlds return the same watch id", async () => {
    const { connect } = await setup();
    const { client, transport } = await connect();
    const original = Router.prototype.dispatch;
    const dispatch = vi.spyOn(Router.prototype, "dispatch").mockImplementation(function (
      this: Router,
      request
    ) {
      if (request.target?.startsWith("remote/")) {
        return Promise.resolve({
          id: request.id,
          result: request.command === "vecs_watch" ? { watch: "w1", members: 1 } : { watch: "w1" },
        });
      }
      return original.call(this, request);
    });
    try {
      for (const target of ["remote/a", "remote/b", "remote/c"]) {
        expect(await call(client, "watch", { target, where: true })).toEqual({
          watch: "w1",
          members: 1,
        });
      }
      await call(client, "unwatch", { target: "remote/a", watch: "w1" });
      dispatch.mockClear();
      await transport.terminateSession();
      expect(
        dispatch.mock.calls.map(([request]) => ({
          target: request.target,
          command: request.command,
          watch: request.params.watch,
        }))
      ).toEqual([
        { target: "remote/b", command: "vecs_unwatch", watch: "w1" },
        { target: "remote/c", command: "vecs_unwatch", watch: "w1" },
      ]);
    } finally {
      dispatch.mockRestore();
    }
  });

  it("tears down local watches directly without routing duplicate unwatch commands", async () => {
    const { connect, world, baseline, component, hook } = await setup();
    const { client, transport } = await connect();
    const { watch } = await call(client, "watch", { where: "Position", include: ["Position"] });
    expect((await client.listResources()).resources[0].uri).toBe(
      `vecs://sessions/world/watch/${watch}`
    );
    const dispatch = vi.spyOn(Router.prototype, "dispatch");
    try {
      await transport.terminateSession();
      expect(dispatch).not.toHaveBeenCalled();
      expect(world.queries.length).toBe(baseline + registrationQueries);
      expect(component.meta._onSet).toBe(hook);
    } finally {
      dispatch.mockRestore();
    }
  });

  it("keeps identical ids in different worlds isolated when unwatching and closing a session", async () => {
    const { connect, server, world, baseline } = await setup();
    const second = new World();
    second.component(Position);
    second.entity("second").add(Position);
    second.flush();
    const secondBaseline = second.queries.length;
    server.registerWorld(second, "second");
    expect(second.queries.filter((q) => q.name === "vecs-mcp.definitions")).toHaveLength(
      registrationQueries
    );
    const { client, transport } = await connect();
    const a = await call(client, "watch", { target: "sessions/world", where: "Position" });
    const b = await call(client, "watch", { target: "sessions/second", where: "Position" });
    expect(a.watch).toBe(b.watch);
    expect((await client.listResources()).resources.map((resource) => resource.uri).sort()).toEqual(
      [`vecs://sessions/second/watch/${b.watch}`, `vecs://sessions/world/watch/${a.watch}`]
    );
    await call(client, "unwatch", { target: "sessions/world", watch: a.watch });
    expect(world.queries.length).toBe(baseline + registrationQueries);
    expect(second.queries.length).toBe(secondBaseline + registrationQueries + 1);
    expect(await call(client, "events", { target: "sessions/second", watch: b.watch })).toEqual({
      events: [],
      latest: 0,
      dropped: 0,
    });
    await transport.terminateSession();
    expect(second.queries.length).toBe(secondBaseline + registrationQueries);
  });

  it.each(["source", "children"])(
    "rejects nested %s through MCP but keeps find support",
    async (operator) => {
      const { connect, world, baseline } = await setup();
      const { client } = await connect();
      const where = {
        any: [
          "Position",
          operator === "source" ? { source: ["ChildOf", "Position"] } : { children: "Position" },
        ],
      };
      const rejected = await client.callTool({
        name: "vecs_watch",
        arguments: { where, include: ["Position"] },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected.content)).toContain(
        `${operator} is filter-only: vecs_find supports it, vecs_watch does not`
      );
      expect(world.queries.length).toBe(baseline + registrationQueries);
      expect((await client.listResources()).resources).toEqual([]);
      expect(await call(client, "find", { where })).toMatchObject({ total: 1 });
    }
  );

  it("isolates two sessions' tools and resources and destroys only the DELETEd session's queries/hooks", async () => {
    const { connect, world, baseline, component, hook } = await setup();
    const a = await connect();
    const b = await connect();
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    const first = await call(a.client, "watch", { where: "Position", include: ["Position"] });
    const second = await call(b.client, "watch", { where: "Position" });
    expect(world.queries.length).toBe(baseline + registrationQueries + 2);
    const resource = (await a.client.listResources()).resources[0];
    expect(resource.uri).toBe(`vecs://sessions/world/watch/${first.watch}`);
    expect((await b.client.listResources()).resources.map((r) => r.uri)).toEqual([
      `vecs://sessions/world/watch/${second.watch}`,
    ]);
    const denied = await b.client.callTool({
      name: "vecs_events",
      arguments: { watch: first.watch },
    });
    expect(denied.isError).toBe(true);
    await expect(b.client.readResource({ uri: resource.uri })).rejects.toThrow(
      "Unknown watch resource"
    );
    await expect(b.client.subscribeResource({ uri: resource.uri })).rejects.toThrow(
      "Unknown watch resource"
    );
    const unwatch = await b.client.callTool({
      name: "vecs_unwatch",
      arguments: { watch: first.watch },
    });
    expect(unwatch.isError).toBe(true);
    await a.transport.terminateSession();
    expect(world.queries.length).toBe(baseline + registrationQueries + 1);
    expect(component.meta._onSet).toBe(hook);
    expect(await call(b.client, "events", { watch: second.watch })).toEqual({
      events: [],
      latest: 0,
      dropped: 0,
    });
    await b.transport.terminateSession();
    expect(world.queries.length).toBe(baseline + registrationQueries);
  });

  it("reads the same log through resources and coalesces a burst into one notification per 100ms", async () => {
    const { connect, entity } = await setup();
    const { client } = await connect();
    const { watch } = await call(client, "watch", { where: "Position", include: ["Position"] });
    const uri = (await client.listResources()).resources[0].uri;
    const notifications: string[] = [];
    let notified!: () => void;
    const arrival = new Promise<void>((resolve) => {
      notified = resolve;
    });
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, ({ params }) => {
      notifications.push(params.uri);
      notified();
    });
    await client.subscribeResource({ uri });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    for (let x = 2; x < 12; x++) {
      entity.set(Position, { x });
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(notifications).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await arrival;
    expect(notifications).toEqual([uri]);
    const events = await call(client, "events", { watch });
    expect(events.latest).toBe(10);
    expect(events.events.at(-1)).toMatchObject({
      kind: "update",
      component: "Position",
      value: { x: 11 },
    });
    const resource = await client.readResource({ uri });
    const content = resource.contents[0];
    expect("text" in content && JSON.parse(content.text)).toEqual(events);
    await client.unsubscribeResource({ uri });
    await call(client, "unwatch", { watch });
    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri })).rejects.toThrow("Unknown watch resource");
  });

  it("closes idle sessions after thirty minutes and gates GET/POST/DELETE independently of session ids", async () => {
    const { connect, url, world, baseline } = await setup("secret");
    const { client, transport } = await connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await call(client, "watch", { where: "Position" });
    vi.useRealTimers();
    for (const method of ["GET", "POST", "DELETE"]) {
      expect(
        (await fetch(url, { method, headers: { "mcp-session-id": transport.sessionId! } })).status
      ).toBe(401);
    }
    // Re-arm using fake time, without virtualizing network scheduling.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await call(client, "stats");
    await vi.advanceTimersByTimeAsync(WATCH_IDLE_MS);
    vi.useRealTimers();
    expect(world.queries.length).toBe(baseline + registrationQueries);
    expect(
      (
        await fetch(url, {
          method: "DELETE",
          headers: { Authorization: "Bearer secret", "mcp-session-id": transport.sessionId! },
        })
      ).status
    ).toBe(404);
  });

  it("server.close releases all sessions' live watches", async () => {
    const { connect, server, world, baseline } = await setup();
    const { client } = await connect();
    await call(client, "watch", { where: "Position", include: ["Position"] });
    await server.close();
    expect(world.queries.length).toBe(baseline);
    expect(world.queries.filter((q) => q.name === "vecs-mcp.definitions")).toEqual([]);
  });

  it("expires an unread watch while its session remains active and reads its resource receipt once", async () => {
    const { connect, world, baseline, component, hook } = await setup();
    const { client } = await connect();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await call(client, "watch", { where: "Position", include: ["Position"] });
    const uri = (await client.listResources()).resources[0].uri;
    await vi.advanceTimersByTimeAsync(WATCH_IDLE_MS / 2);
    await call(client, "stats");
    await vi.advanceTimersByTimeAsync(WATCH_IDLE_MS / 2);
    expect(world.queries.length).toBe(baseline + registrationQueries);
    expect(component.meta._onSet).toBe(hook);
    expect((await client.listResources()).resources).toEqual([]);
    const resource = await client.readResource({ uri });
    const content = resource.contents[0];
    expect("text" in content && JSON.parse(content.text)).toEqual({
      events: [],
      latest: 0,
      dropped: -1,
    });
    await expect(client.readResource({ uri })).rejects.toThrow("Unknown watch resource");
  });
});
