import { describe, expect, it } from "vitest";
import { frameSchema } from "../../src/links/protocol.js";

const node = { name: "game", nodeId: "game-id", pid: 1, cwd: "/work", branch: "dev", sha: "abc" };
const target = { path: "game/world", kind: "world", node, via: ["game-id"] };

describe("link frame validation", () => {
  it.each([
    { type: "hello", protocol: 1, role: "join", name: "game", nodeId: "game-id", token: "secret" },
    { type: "hello", protocol: 1, role: "mount", name: "game", nodeId: "game-id" },
    { type: "welcome", name: "game", nodeId: "game-id" },
    { type: "reject", reason: "Duplicate name" },
    { type: "advertise", node, targets: [target] },
    { type: "request", id: "1", target: "game/world", command: "vecs_stats", params: {} },
    { type: "response", id: "1", result: { systems: [] } },
    { type: "response", id: "1", error: { code: "VECS_ERROR", message: "failed", hops: ["game"] } },
  ])("accepts a well-shaped $type frame", (frame) => {
    expect(frameSchema.parse(frame)).toEqual(frame);
  });

  it.each([
    null,
    [],
    {},
    { type: "hello", protocol: 2, role: "join", name: "game", nodeId: "id" },
    { type: "hello", protocol: 1, role: "other", name: "game", nodeId: "id" },
    { type: "hello", protocol: 1, role: "join", name: "bad/name", nodeId: "id" },
    { type: "hello", protocol: 1, role: "join", name: "game", nodeId: "id", token: 5 },
    { type: "welcome", name: "game" },
    { type: "reject", reason: 5 },
    { type: "advertise", node, targets: [{ ...target, via: [] }] },
    { type: "advertise", node, targets: [{ ...target, node: null }] },
    { type: "advertise", node, targets: [{ ...target, world: "bad" }] },
    { type: "request", id: 1, target: "game/world", command: "vecs_stats", params: {} },
    { type: "request", id: "1", target: "game/world", command: "vecs_stats", params: [] },
    { type: "response", id: "1", error: { code: "FAIL", message: "failed", hops: "game" } },
    { type: "response", id: "1" },
    {
      type: "response",
      id: "1",
      result: null,
      error: { code: "FAIL", message: "failed", hops: [] },
    },
    { type: "welcome", name: "game", nodeId: "id", extra: true },
  ])("rejects malformed frames %j", (frame) => {
    expect(frameSchema.safeParse(frame).success).toBe(false);
  });
});
