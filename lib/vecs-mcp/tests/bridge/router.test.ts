import { afterEach, expect, it, vi } from "vitest";
import { World } from "@vworlds/vecs";
import { ServerWorld, NetworkClient } from "@vworlds/vecs-server";
import { Router } from "../../src/bridge/router.js";
import { BridgeClient } from "../../src/tunnel/index.js";
import { Link } from "../../src/links/link.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.restoreAllMocks();
});

function expose(router: Router) {
  const frames: { type: string; targets?: { path: string }[] }[] = [];
  const link = new Link(router);
  cleanup.push(() => link.close());
  link._attach({ send: (data) => frames.push(JSON.parse(data)), close: () => {} });
  link._receive(
    JSON.stringify({ type: "hello", protocol: 1, role: "mount", name: "hub", nodeId: "hub-id" })
  );
  return frames;
}

it("coalesces bridged connects and disconnects outside command drain without entity scans", async () => {
  const world = new ServerWorld();
  cleanup.push(() => world.dispose());
  const router = new Router("node", {});
  router.register(world, "main");
  // Settle registration before attaching an exposing link.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const frames = expose(router);
  const otherFrames = expose(router);
  frames.length = 0;
  otherFrames.length = 0;
  const table = vi.spyOn(router, "table");
  const filter = vi.spyOn(world, "filter");
  const values = vi.spyOn(world.entities, "values");
  const iterator = vi.spyOn(world.entities, Symbol.iterator);
  const clients: ReturnType<World["entity"]>[] = [];
  world.system("connect").run(() => {
    if (clients.length) {
      return;
    }
    for (let i = 0; i < 4; i++) {
      clients.push(
        world
          .entity()
          .set(NetworkClient, { id: `c${i}` })
          .add(BridgeClient)
      );
    }
  });
  world.progress(0, 16);
  expect(frames).toEqual([]);
  expect(otherFrames).toEqual([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(frames).toEqual([
    expect.objectContaining({
      type: "advertise",
      targets: [
        expect.objectContaining({ path: "node/main" }),
        ...clients.map((_, i) => expect.objectContaining({ path: `node/main/c${i}` })),
      ],
    }),
  ]);
  expect(otherFrames).toEqual(frames);
  expect(table).toHaveBeenCalledTimes(1);
  frames.length = 0;
  world.defer(() =>
    clients.forEach((client, i) => (i % 2 ? client.remove(BridgeClient) : client.destroy()))
  );
  expect(frames).toEqual([]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(frames).toEqual([
    expect.objectContaining({
      type: "advertise",
      targets: [expect.objectContaining({ path: "node/main" })],
    }),
  ]);
  expect(filter).not.toHaveBeenCalled();
  expect(values).not.toHaveBeenCalled();
  expect(iterator).not.toHaveBeenCalled();
  expect(table).toHaveBeenCalledTimes(2);
});

it("seeds existing bridged clients for aliases and reads current client metadata", () => {
  const world = new ServerWorld();
  cleanup.push(() => world.dispose());
  const router = new Router("node", {});
  router.register(world, "main");
  const client = world.entity("before").set(NetworkClient, { id: "browser" }).add(BridgeClient);
  router.register(world, "alias");
  client.name = "after";
  expect(router.table().targets.filter((entry) => entry.kind === "client")).toMatchObject([
    { path: "node/main/browser", client: { name: "after", eid: client.eid } },
    { path: "node/alias/browser", client: { name: "after", eid: client.eid } },
  ]);
  client.remove(NetworkClient);
  client.remove(BridgeClient);
  expect(router.table().targets.map((entry) => entry.path)).toEqual(["node/main", "node/alias"]);
});

it("does no topology rebuild without an exposing link and drops unsubscribed queued work", async () => {
  const world = new ServerWorld();
  cleanup.push(() => world.dispose());
  const router = new Router("node", {});
  router.register(world, "main");
  const table = vi.spyOn(router, "table");
  const client = world.entity().set(NetworkClient, { id: "browser" }).add(BridgeClient);
  client.destroy();
  router.changed();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(table).not.toHaveBeenCalled();
  const changed = vi.fn();
  const off = router.onChange(changed);
  router.changed();
  off();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(changed).not.toHaveBeenCalled();
});

it("only enumerates destination paths for omitted targets or unknown destinations", async () => {
  const router = new Router("node", {});
  const paths = vi.fn(() => ["peer/world"]);
  router.destinations.set("peer", { paths, dispatch: () => "ok" });
  const request = { id: "test", command: "vecs_stats", params: {} };
  expect(await router.dispatch({ ...request, target: "peer/world" })).toEqual({
    id: "test",
    result: "ok",
  });
  expect(paths).not.toHaveBeenCalled();
  expect(await router.dispatch({ ...request, target: "missing/world" })).toMatchObject({
    error: { message: "Unknown target missing/world; available targets: peer/world" },
  });
  expect(paths).toHaveBeenCalledTimes(1);
  router.destinations.delete("node");
  expect(await router.dispatch(request)).toEqual({ id: "test", result: "ok" });
  expect(paths).toHaveBeenCalledTimes(2);
  router.destinations.clear();
  expect(await router.dispatch({ ...request, target: "missing/world" })).toMatchObject({
    error: { message: "Unknown target missing/world; available targets: (none)" },
  });
});
