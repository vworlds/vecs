import { describe, expect, it } from "vitest";
import { Entity, Exclusive, Relationship, World } from "../src/index.js";

class Link extends Relationship {}
class Producer {}

describe("relationship update drains", () => {
  it("does not leave an absent relationship dirty across later entry and edge changes", () => {
    const world = new World();
    world.component(Link);
    const source = world.entity();
    const a = world.entity();
    const b = world.entity();
    const seen: Entity[][] = [];
    world
      .query("absent-modified")
      .with(Link)
      .update({ watch: Link }, (e) => seen.push([...e.targets(Link)]))
      .build();
    world.defer(() => source.modified(Link));
    expect(seen).toEqual([]);
    world.defer(() => source.add(Link, a));
    expect(seen).toEqual([]);
    world.defer(() => source.add(Link, b));
    expect(seen).toEqual([[a, b]]);
    world.dispose();
  });

  it("commits edges queued by onSet before the coalesced synchronous update", () => {
    const world = new World();
    const rel = world.component(Link);
    const a = world.entity();
    const b = world.entity();
    const source = world.entity().add(Link, a);
    rel.on("set", (e) => e.add(Link, b));
    const seen: Entity[][] = [];
    world
      .query("data-hook")
      .with(Link)
      .update({ watch: Link }, (e) => seen.push([...e.targets(Link)]))
      .build();
    world.defer(() => source.modified(Link));
    expect(seen).toEqual([[a, b]]);
    world.dispose();
  });

  it("preserves the edge producer's ignoreSource domain", () => {
    const world = new World();
    world.component(Link);
    world.component(Producer);
    const a = world.entity();
    const b = world.entity();
    const source = world.entity().add(Link, a);
    const producer = world.system("producer").run(() => source.add(Link, b));
    producer.entity.add(Producer);
    let ignored = 0;
    let received = 0;
    world
      .system("ignored")
      .with(Link)
      .ignoreSource([Producer])
      .update({ watch: Link }, () => ignored++);
    world
      .system("received")
      .with(Link)
      .update({ watch: Link }, () => received++);
    world.progress(0, 0);
    expect(ignored).toBe(0);
    expect(received).toBe(1);
    world.dispose();
  });

  it("preserves data hooks only for explicit modified, including when an edge dirtied first", () => {
    const world = new World();
    world.component(Link);
    const source = world.entity().add(Link, world.entity());
    let sets = 0;
    world.component(Link).on("set", () => sets++);
    world.defer(() => source.add(Link, world.entity()));
    expect(sets).toBe(0);
    world.defer(() => {
      source.add(Link, world.entity());
      source.modified(Link);
      source.modified(Link);
    });
    expect(sets).toBe(1);
    world.defer(() => {
      source.modified(Link);
      source.add(Link, world.entity());
    });
    expect(sets).toBe(2);
    world.dispose();
  });

  it("includes edges queued by edge hooks before the single synchronous update", () => {
    const world = new World();
    world.component(Link);
    const first = world.entity();
    const second = world.entity();
    const third = world.entity();
    const source = world.entity().add(Link, first);
    world.component(Link).on("targetAdd", (e, _r, t) => {
      if (t === second) {
        e.add(Link, third);
      }
    });
    const seen: Entity[][] = [];
    world
      .query("hook-edges")
      .with(Link)
      .update({ watch: Link }, (e) => seen.push([...e.targets(Link)]))
      .build();
    world.defer(() => {
      source.modified(Link);
      source.add(Link, second);
    });
    expect(seen).toEqual([[first, second, third]]);
    world.dispose();
  });

  const cases = ["add-modified", "modified-add", "three-adds", "add-remove", "remove-add"] as const;
  it.each(cases)("coalesces %s for synchronous and system watchers after edges commit", (kind) => {
    const world = new World();
    world.component(Link);
    const targets = Array.from({ length: 5 }, () => world.entity());
    const source = world.entity().add(Link, targets[0]!).add(Link, targets[1]!);
    const sync: Entity[][] = [];
    const replay: Entity[][] = [];
    world
      .query("sync")
      .with(Link)
      .update({ watch: Link }, (e) => sync.push([...e.targets(Link)]))
      .build();
    world
      .system("replay")
      .with(Link)
      .update({ watch: Link }, (e) => replay.push([...e.targets(Link)]));
    world.progress(0, 0);
    const added: Entity[] = [];
    const removed: Entity[] = [];
    world.component(Link).on("targetAdd", (_e, _r, t) => added.push(t));
    world.component(Link).on("targetRemove", (_e, _r, t) => removed.push(t));
    world.defer(() => {
      if (kind === "modified-add") {
        source.modified(Link);
      }
      if (kind === "remove-add") {
        source.remove(Link, targets[1]!);
      }
      source.add(Link, targets[2]!);
      if (kind === "add-modified") {
        source.modified(Link);
      }
      if (kind === "three-adds") {
        source.add(Link, targets[3]!).add(Link, targets[4]!);
      }
      if (kind === "add-remove") {
        source.remove(Link, targets[1]!);
      }
      if (kind === "remove-add") {
        source.add(Link, targets[1]!);
      }
    });
    const expected = [...source.targets(Link)];
    expect(sync).toEqual([expected]);
    world.progress(1, 1);
    expect(replay).toEqual([expected]);
    expect(added).toEqual(
      kind === "three-adds"
        ? targets.slice(2)
        : kind === "remove-add"
          ? [targets[2], targets[1]]
          : [targets[2]]
    );
    expect(removed).toEqual(kind === "add-remove" || kind === "remove-add" ? [targets[1]] : []);
    world.defer(() => source.modified(Link));
    expect(sync).toHaveLength(2);
    world.dispose();
  });

  it("keeps entry, exit and removal/re-entry distinct without stale updates", () => {
    const world = new World();
    world.component(Link);
    const source = world.entity();
    const a = world.entity();
    const b = world.entity();
    const events: string[] = [];
    world
      .query("lifecycle")
      .with(Link)
      .enter(() => events.push("enter"))
      .exit(() => events.push("exit"))
      .update({ watch: Link }, () => events.push("update"))
      .build();
    world.defer(() => source.add(Link, a));
    expect(events).toEqual(["enter"]);
    world.defer(() => {
      source.add(Link, b);
      source.remove(Link);
      source.add(Link, a);
    });
    expect(events).toEqual(["enter", "exit", "enter"]);
    world.defer(() => source.remove(Link, a));
    expect(events).toEqual(["enter", "exit", "enter", "exit"]);
    source.add(Link, a);
    world.defer(() => {
      source.add(Link, b);
      source.destroy();
    });
    expect(events.slice(-2)).toEqual(["enter", "exit"]);
    expect(events).not.toContain("update");
    world.dispose();
  });

  it.each([false, true])(
    "leaves duplicate edges and absent removals silent (exclusive=%s)",
    (exclusive) => {
      const world = new World();
      const rel = world.component(Link);
      if (exclusive) {
        rel.add(Exclusive);
      }
      const a = world.entity();
      const b = world.entity();
      const source = world.entity().add(Link, a);
      const events: string[] = [];
      rel
        .on("targetAdd", () => events.push("add"))
        .on("targetRemove", () => events.push("remove"))
        .on("set", () => events.push("set"));
      world
        .query("silent")
        .with(Link)
        .update({ watch: Link }, () => events.push("update"))
        .build();
      world.defer(() => {
        source.add(Link, a);
        source.remove(Link, b);
        world.entity().remove(Link);
      });
      expect(events).toEqual([]);
      world.dispose();
    }
  );

  it("routes each immediate change and exclusive replacement", () => {
    const world = new World();
    world.component(Link).add(Exclusive);
    const targets = Array.from({ length: 3 }, () => world.entity());
    const source = world.entity().add(Link, targets[0]!);
    const seen: Entity[][] = [];
    world
      .query("immediate")
      .with(Link)
      .update({ watch: Link }, (e) => seen.push([...e.targets(Link)]))
      .build();
    source.add(Link, targets[1]!);
    source.modified(Link);
    source.add(Link, targets[2]!);
    expect(seen).toEqual([[targets[1]], [targets[1]], [targets[2]]]);
    world.defer(() => {
      source.modified(Link);
      source.add(Link, targets[0]!);
      source.add(Link, targets[1]!);
    });
    expect(seen.slice(3)).toEqual([[targets[1]]]);
    world.dispose();
  });
});
