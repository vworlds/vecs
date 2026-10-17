import { afterEach, expect, it, vi } from "vitest";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  BRIDGE_ANNOUNCE_RPC_ID,
  BRIDGE_CALL_RPC_ID,
  RPC,
  RPC_CLOSED_CODE,
  type RPCHandler,
} from "@vworlds/vecs-protocol";
import { installBridge } from "../src/client.js";

afterEach(() => vi.useRealTimers());

function setup(readOnly = false) {
  const world = new ClientWorld();
  const listen = vi.spyOn(world, "listen");
  const bridge = installBridge(world, { readOnly });
  const handler = listen.mock.calls.find(([id]) => id === BRIDGE_CALL_RPC_ID)![1];
  const call = (command: string, params: Record<string, unknown>) =>
    Promise.resolve(handler([{ id: "test", command, params }], new RPC(), undefined));
  return { world, bridge, handler, call };
}

it("runs on a macrotask, not a microtask, with inline read-after-write semantics", async () => {
  vi.useFakeTimers();
  const { world, call } = setup();
  class Position {
    x = 0;
  }
  world.component(Position);
  let result: unknown;
  let pending!: Promise<unknown>;
  world.system("request").run(() => {
    expect(world.deferred).toBe(true);
    pending = call("vecs_mutate", {
      ops: [
        { create: true, name: "new" },
        { set: true, entity: "$0", component: "Position", value: { x: 7 } },
        { set: true, entity: "new", component: "Position", value: { x: 9 } },
      ],
    }).then((response) => {
      result = response;
    });
  });
  world.progress(0, 16);
  expect(world.deferred).toBe(false);
  await Promise.resolve();
  expect(result).toBeUndefined();
  expect(world.getEntity("new")).toBeUndefined();
  await vi.runAllTimersAsync();
  await pending;
  expect(result).toMatchObject({
    result: {
      applied: [
        { eid: expect.any(Number) },
        { eid: expect.any(Number) },
        { eid: expect.any(Number) },
      ],
    },
  });
  expect(world.getEntity("new")!.get(Position)!.x).toBe(9);
  world.dispose();
});

it.each(["dispose", "uninstall"])(
  "rejects rather than hangs when %s precedes the macrotask",
  async (action) => {
    vi.useFakeTimers();
    const { world, bridge, call } = setup();
    const rejected = expect(call("vecs_stats", {})).rejects.toMatchObject({
      code: RPC_CLOSED_CODE,
    });
    if (action === "dispose") {
      world.dispose();
    } else {
      bridge.uninstall();
    }
    await vi.runAllTimersAsync();
    await rejected;
    world.dispose();
  }
);

it("reports the exact applied prefix without rollback or replay on a runtime failure", async () => {
  vi.useFakeTimers();
  const { world, call } = setup();
  class Position {
    x = 0;
  }
  world.component(Position).on("set", () => {
    throw new Error("hook failed");
  });
  const result = call("vecs_mutate", {
    ops: [
      { create: true, name: "prefix" },
      { set: true, entity: "$0", component: "Position", value: { x: 3 } },
      { create: true, name: "unattempted" },
    ],
  });
  await vi.runAllTimersAsync();
  await expect(result).resolves.toMatchObject({
    result: {
      applied: [{ eid: expect.any(Number) }],
      error: { index: 1, message: "hook failed" },
    },
  });
  expect(world.getEntity("prefix")!.get(Position)!.x).toBe(3);
  expect(world.getEntity("unattempted")).toBeUndefined();
  world.progress(16, 16);
  expect(world.getEntity("unattempted")).toBeUndefined();
  world.dispose();
});

it("rejects a deferred world and enforces client readOnly", async () => {
  vi.useFakeTimers();
  const { world, call } = setup(true);
  const pending = call("vecs_mutate", { ops: [{ create: true }] });
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toMatchObject({
    error: { message: expect.stringContaining("readOnly") },
  });
  world.dispose();
  const writable = setup();
  const deferred = writable.call("vecs_mutate", { ops: [{ create: true }] });
  writable.world.beginDefer();
  await vi.runAllTimersAsync();
  await expect(deferred).resolves.toMatchObject({
    error: { message: expect.stringContaining("deferred") },
  });
  writable.world.endDefer();
  writable.world.dispose();
});

it("announces once per attachment before/after install and removes only its own handler", () => {
  const world = new ClientWorld();
  const announce = vi.spyOn(world, "invoke").mockResolvedValue([]);
  const socket = {
    id: "test",
    on() {
      return this;
    },
    send() {},
    close() {},
  };
  const bridge = installBridge(world);
  expect(announce).not.toHaveBeenCalled();
  world.attachSocket(socket);
  expect(announce).toHaveBeenCalledExactlyOnceWith(BRIDGE_ANNOUNCE_RPC_ID);
  world.close();
  world.attachSocket(socket);
  expect(announce).toHaveBeenCalledTimes(2);
  const replacement: RPCHandler = () => "replacement";
  world.listen(BRIDGE_CALL_RPC_ID, replacement);
  bridge.uninstall();
  bridge.uninstall();
  expect(world.unlisten(BRIDGE_CALL_RPC_ID, replacement)).toBe(true);
  world.attachSocket(socket);
  expect(announce).toHaveBeenCalledTimes(2);
  const late = installBridge(world);
  expect(announce).toHaveBeenCalledTimes(3);
  late.uninstall();
  world.dispose();
});
