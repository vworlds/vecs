import { type Entity, World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  Body,
  BodyType,
  Box,
  ContactEvents,
  HitEvents,
  LinearVelocity,
  PhysicsModule,
  Position,
  Sensor,
  SensorEvents,
} from "../../src/index.js";

type Events = ContactEvents | SensorEvents | HitEvents;
const cases: { name: string; Class: new () => Events }[] = [
  { name: "contact", Class: ContactEvents },
  { name: "sensor", Class: SensorEvents },
  { name: "hit", Class: HitEvents },
];

describe.each(cases)("$name event snapshot policy", ({ Class }) => {
  for (const transfer of ["move", "restore"] as const) {
    for (const explicit of [false, true]) {
      it(`${transfer} preserves opt-in with ${explicit ? "explicit" : "implicit"} selection and discards source buffers`, () => {
        const source = physicsWorld();
        const destination = transfer === "move" ? physicsWorld() : source;
        try {
          const body = source
            .entity()
            .set(Body, { type: BodyType.Dynamic })
            .set(Position, { x: 3, y: 0 })
            .set(LinearVelocity, { x: -10, y: 0 });
          const shape = source.entity().childOf(body).set(Box, { width: 2, height: 2 }).add(Class);
          if (Class === SensorEvents) {
            shape.add(Sensor);
          }
          step(source);
          const original = shape.get(Class)!;
          const sourceOther = source.entity();
          seedBuffers(original, sourceOther);

          const options = explicit
            ? {
                components: [
                  Body,
                  Position,
                  LinearVelocity,
                  Box,
                  Sensor,
                  ContactEvents,
                  SensorEvents,
                  HitEvents,
                ],
              }
            : {};
          const snapshot = source.snapshotSubtree(body, options);
          const record = snapshot.entities.find((record) => record.key === shape.eid);
          expect(record?.components.find((component) => component.Class === Class)?.data).toEqual(
            {}
          );

          if (transfer === "restore") {
            body.destroy();
          }
          const result =
            transfer === "move"
              ? source.moveSubtree(body, destination, options)
              : source.restoreSubtree(source, snapshot);
          const movedShape = result.entities.get(shape.eid)!;
          const events = movedShape.get(Class)!;
          expect(events).toBeInstanceOf(Class);
          expect(events).not.toBe(original);
          expect(events).toEqual(new Class());
          expect(buffers(events)).not.toBe(buffers(original));

          const wall = destination.entity().set(Body, { type: BodyType.Static });
          const wallShape = destination.entity().childOf(wall).set(Box, { width: 2, height: 2 });
          if (Class === SensorEvents) {
            wallShape.add(SensorEvents);
          }
          for (let i = 0; i < 60 && buffers(events).length === 0; i++) {
            step(destination);
          }
          expect(buffers(events).length).toBeGreaterThan(0);
          expect(buffers(events).map((event) => event.other)).toContain(wallShape);
          expect(buffers(events).every((event) => event.other.world === destination)).toBe(true);
          expect(buffers(events).map((event) => event.other)).not.toContain(sourceOther);
        } finally {
          if (destination !== source) {
            destination.dispose();
          }
          source.dispose();
        }
      });
    }
  }
});

function physicsWorld(): World {
  const world = new World();
  world.module(PhysicsModule, { gravity: { x: 0, y: 0 }, hitEventThreshold: 0.5 });
  return world;
}

function step(world: World): void {
  world.progress(1000 / 60, 1000 / 60);
}

function seedBuffers(events: Events, other: Entity): void {
  if ("hits" in events) {
    events.hits.push({ other, x: 1, y: 2, normalX: 1, normalY: 0, speed: 10 });
  } else {
    events.begin.push({ other });
    events.end.push({ other });
  }
}

function buffers(events: Events): { other: Entity }[] {
  return "hits" in events ? events.hits : events.begin;
}
