import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { World } from "@vworlds/vecs";
import { createRequire } from "node:module";
import { VecsMcpServer } from "../src/index.js";

const servers: VecsMcpServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(options = {}) {
  class Position {
    x = 1;
  }
  const world = new World();
  world.component(Position);
  world.entity("sample").add(Position);
  world.system("move").run(() => {});
  const server = new VecsMcpServer({ name: "test", ...options });
  servers.push(server);
  server.registerWorld(world);
  const port = await server.listen(0);
  return { server, world, url: new URL(`http://127.0.0.1:${port}/mcp`) };
}

async function connect(url: URL, token?: string) {
  const client = new Client({ name: "test-client", version: "1" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    })
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name: `vecs_${name}`, arguments: args });
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as { text: string }[])[0].text);
}

describe("Streamable HTTP MCP", () => {
  it("lists ten tools and invokes the original seven through the SDK client", async () => {
    const { url } = await start();
    const client = await connect(url);
    expect(client.getServerVersion()).toEqual({
      name: "test",
      version: createRequire(import.meta.url)("../package.json").version,
    });
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name).sort()).toEqual([
      "vecs_components",
      "vecs_entity",
      "vecs_events",
      "vecs_find",
      "vecs_mutate",
      "vecs_stats",
      "vecs_systems",
      "vecs_targets",
      "vecs_unwatch",
      "vecs_watch",
    ]);
    expect(listing.tools.every((tool) => (tool.description?.length ?? 0) > 30)).toBe(true);
    expect(await call(client, "targets")).toMatchObject({
      node: { name: "test", pid: process.pid, cwd: process.cwd() },
      targets: [{ path: "test/world", kind: "world", world: { name: "world", systems: 1 } }],
    });
    expect(await call(client, "components", { filter: "Position" })).toEqual([
      expect.objectContaining({
        name: "Position",
        schema: expect.objectContaining({ properties: { x: { type: "number" } } }),
      }),
    ]);
    expect(await call(client, "find", { where: "Position" })).toMatchObject({
      total: 1,
      entities: [{ name: "sample", components: {} }],
    });
    expect(await call(client, "entity", { entity: "sample" })).toMatchObject({
      name: "sample",
      components: { Position: { x: 1 } },
    });
    expect(
      await call(client, "mutate", {
        ops: [{ set: true, entity: "sample", component: "Position", value: { x: 5 } }],
      })
    ).toMatchObject({ applied: [{ eid: expect.any(Number) }] });
    expect(await call(client, "entity", { entity: "sample" })).toMatchObject({
      components: { Position: { x: 5 } },
    });
    expect(await call(client, "systems", { disable: "move" })).toEqual([
      expect.objectContaining({ name: "move", enabled: false }),
    ]);
    expect(await call(client, "stats")).toMatchObject({
      operations: [],
      systems: [{ name: "move", runs: 0 }],
    });
    const error = await client.callTool({
      name: "vecs_find",
      arguments: { where: { test: "no" } },
    });
    expect(error.isError).toBe(true);
    expect(JSON.stringify(error.content)).toContain("test predicates");
  });

  it("requires a target with two worlds and rejects duplicate world names", async () => {
    const { server, url, world } = await start();
    expect(() => server.registerWorld(world)).toThrow("Duplicate world");
    server.registerWorld(new World(), "second");
    const client = await connect(url);
    const result = await client.callTool({ name: "vecs_stats", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("test/world, test/second");
    expect(await call(client, "find", { target: "test/world", where: "Position" })).toMatchObject({
      total: 1,
    });
    expect(await call(client, "stats", { target: "test/second" })).toEqual({
      systems: [],
      operations: [],
    });
  });

  it("rejects absent/incorrect bearer tokens and accepts the correct token", async () => {
    const { url } = await start({ token: "secret" });
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect(
      (await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong" } })).status
    ).toBe(401);
    const client = await connect(url, "secret");
    expect(await call(client, "find", { where: "Position" })).toMatchObject({ total: 1 });
  });

  it("enforces readOnly via MCP and closes idempotently", async () => {
    const { server, url } = await start({ readOnly: true });
    const client = await connect(url);
    for (const [name, args] of [
      ["vecs_mutate", { ops: [{ create: true }] }],
      ["vecs_systems", { disable: "move" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("readOnly");
    }
    await client.close();
    await server.close();
    await server.close();
  });
});
