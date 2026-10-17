import { expect, it } from "vitest";
import { Peer } from "../../src/links/peer.js";

it("routes only advertised paths and replaces the whole cached target table", async () => {
  const entry = {
    path: "game/world",
    kind: "world",
    node: { name: "game", nodeId: "id" },
    via: ["id"],
  };
  const request = { id: "1", target: "game/world", command: "vecs_stats", params: {} };
  const peer = new Peer([entry], async (forwarded) => ({ target: forwarded.target }));
  expect(peer.paths()).toEqual(["game/world"]);
  expect(peer.targets()).toEqual([entry]);
  expect(await peer.dispatch(request)).toEqual({ target: "game/world" });
  expect(() => peer.dispatch({ ...request, target: "game/missing" })).toThrow(
    "Unknown target game/missing"
  );
  peer.entries = [];
  expect(peer.paths()).toEqual([]);
  expect(() => peer.dispatch(request)).toThrow("Unknown target game/world");
});
