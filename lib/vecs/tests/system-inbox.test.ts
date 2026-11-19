import { describe, expect, it } from "vitest";
import { type Entity, World } from "../src/index.js";

class Value {
  n = 0;
}

/** Every inbox slot that can hold an entity or a payload, including drained ones. */
function retained(system: unknown): unknown[] {
  const inbox = system as { _inboxEntities: unknown[]; _inboxPayloads: unknown[] };
  return [...inbox._inboxEntities, ...inbox._inboxPayloads].filter((slot) => slot !== undefined);
}

function scene() {
  const world = new World();
  world.component(Value);
  const seen: [string, Entity, number | undefined][] = [];
  const system = world
    .system("inbox")
    .with(Value)
    .enter((entity) => seen.push(["enter", entity, undefined]))
    .update({ watch: Value }, (entity, value) => seen.push(["update", entity, value.n]))
    .exit([Value], (entity, [value]) => seen.push(["exit", entity, value?.n]));
  const entities = Array.from({ length: 5 }, (_, n) => world.entity().set(Value, { n }));
  return { world, system, seen, entities };
}

describe("system inbox", () => {
  it("releases entities and payloads after a drain and reuses the slots", () => {
    const { world, system, seen, entities } = scene();
    // Routed but not yet replayed: the inbox holds the entities and their payloads.
    world.flush();
    expect(retained(system)).toEqual(expect.arrayContaining(entities));
    world.progress(0, 16);
    expect(seen).toEqual(entities.map((entity) => ["enter", entity, undefined]));
    expect(retained(system)).toEqual([]);

    // A shorter second window replays only its own events from the reused slots.
    seen.length = 0;
    entities[1]!.set(Value, { n: 11 });
    entities[3]!.remove(Value);
    world.progress(16, 16);
    expect(seen).toEqual([
      ["update", entities[1], 11],
      ["exit", entities[3], 3],
    ]);
    expect(retained(system)).toEqual([]);

    // An empty window leaves nothing behind and replays nothing.
    seen.length = 0;
    world.progress(32, 16);
    expect(seen).toEqual([]);
    expect(retained(system)).toEqual([]);
    world.dispose();
  });

  it("releases pending events on disable and delivers none of them later", () => {
    const { world, system, seen, entities } = scene();
    world.flush();
    expect(retained(system)).not.toEqual([]);
    system.disable();
    expect(retained(system)).toEqual([]);
    world.progress(0, 16);
    expect(seen).toEqual([]);

    system.enable();
    entities[2]!.set(Value, { n: 22 });
    world.progress(16, 16);
    expect(seen).toEqual([["update", entities[2], 22]]);
    expect(retained(system)).toEqual([]);
    world.dispose();
  });
});
