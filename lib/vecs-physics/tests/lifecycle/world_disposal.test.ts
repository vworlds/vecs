import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { World } from "@vworlds/vecs";
import { describe, expect, it, vi } from "vitest";
import {
  Body,
  BodyType,
  Circle,
  ContactEvents,
  HitEvents,
  PhysicsModule,
  SensorEvents,
} from "../../src/index.js";
import { getPhysicsEngine, PhysicsEngine } from "../../src/adapter/engine.js";

describe("physics world disposal", () => {
  for (const mode of ["empty", "chain", "capacity", "memory"]) {
    it(`bounds the isolated ${mode} regression process`, () => {
      // A synchronous WASM hang cannot be interrupted by a Vitest test timeout.
      // A separate process also keeps an exhausted Box2D world table out of other tests.
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../fixtures/world-disposal.ts", import.meta.url)),
          mode,
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
          },
          timeout: 20_000,
          killSignal: "SIGKILL",
          encoding: "utf8",
        }
      );
      expect({
        error: result.error?.message,
        status: result.status,
        output: result.stdout + result.stderr,
      }).toEqual({
        error: undefined,
        status: 0,
        output: `PASS ${mode}\n`,
      });
    }, 25_000);
  }

  it("refuses mid-tick disposal, keeps physics usable, then releases at top level", () => {
    const world = new World();
    world.module(PhysicsModule);
    const engine = getPhysicsEngine(world);
    const id = engine.worldId;
    const body = world.entity().set(Body, { type: BodyType.Dynamic });
    world.entity().childOf(body).set(Circle, { radius: 1 });
    world.progress(0, 1000 / 30);
    let ran = false;
    world
      .system("dispose mid-tick")
      .phase(engine.phases.preStep)
      .run(() => {
        ran = true;
        expect(engine.box2d.b2World_IsValid(id)).toBe(true);
        expect(() => world.dispose()).toThrow(
          "dispose() must be called outside progress(), defer, a command drain or an entity's destroy"
        );
        expect(engine.box2d.b2World_IsValid(id)).toBe(true);
      });
    expect(() => world.progress(1, 1000 / 30)).not.toThrow();
    expect(ran).toBe(true);
    expect(body.alive).toBe(true);
    expect(engine.box2d.b2World_IsValid(id)).toBe(true);
    expect(() => world.progress(2, 1000 / 30)).not.toThrow();
    expect(() => world.dispose()).not.toThrow();
    expect(engine.box2d.b2World_IsValid(id)).toBe(false);
    expect(body.destroyed).toBe(true);
    expect(world.entities.values()).toEqual([]);
    expect(() => world.dispose()).not.toThrow();
  });

  for (const engineFirst of [false, true]) {
    it(`keeps teardown off dead shape ids (engine first: ${engineFirst})`, () => {
      class InfrastructureBody {}
      class InfrastructureShape {}
      const world = new World();
      world.module(PhysicsModule);
      const engine = getPhysicsEngine(world);
      const id = engine.worldId;
      const shapes = [];
      // Exercise both application entities and component entities. Infrastructure
      // order is not a resource dependency contract.
      for (const infrastructure of [false, true]) {
        const body = (infrastructure ? world.component(InfrastructureBody) : world.entity()).set(
          Body,
          { type: BodyType.Dynamic }
        );
        const shape = (infrastructure ? world.component(InfrastructureShape) : world.entity())
          .childOf(body)
          .set(Circle, { radius: 1 })
          .add(ContactEvents)
          .add(HitEvents)
          .add(SensorEvents);
        shapes.push(shape);
      }
      world.progress(0, 1000 / 30);
      const calls: string[] = [];
      const spies = (
        [
          "b2Shape_EnableContactEvents",
          "b2Shape_EnableHitEvents",
          "b2Shape_EnableSensorEvents",
        ] as const
      ).map((name) => {
        const original = engine.box2d[name];
        return vi.spyOn(engine.box2d, name).mockImplementation((shape, enabled) => {
          calls.push(name);
          expect(engine.box2d.b2World_IsValid(id), name).toBe(true);
          expect(engine.box2d.b2Shape_IsValid(shape), name).toBe(true);
          original(shape, enabled);
        });
      });
      try {
        if (engineFirst) {
          world.component(PhysicsEngine).remove(PhysicsEngine);
        }
        for (const shape of shapes) {
          shape.remove(ContactEvents);
          shape.remove(HitEvents);
          shape.remove(SensorEvents);
        }
        expect(() => world.dispose()).not.toThrow();
        expect(engine.box2d.b2World_IsValid(id)).toBe(false);
        if (engineFirst) {
          expect(calls).toEqual([]);
        } else {
          expect(calls.length).toBeGreaterThan(0);
        }
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    });
  }

  it("releases resources when the engine singleton is removed manually", () => {
    const world = new World();
    world.module(PhysicsModule);
    const engine = getPhysicsEngine(world);
    const id = engine.worldId;
    const releaseMoves = vi.spyOn(engine.moveExporter, "dispose");
    world.progress(0, 1000 / 30);
    world.component(PhysicsEngine).remove(PhysicsEngine);
    expect(engine.box2d.b2World_IsValid(id)).toBe(false);
    expect(() => engine.worldId).toThrow("disposed");
    expect(() => engine.world).toThrow("disposed");
    expect(engine.moveExporter.ptr).toBe(0);
    engine.dispose();
    expect(() => world.dispose()).not.toThrow();
    expect(releaseMoves).toHaveBeenCalledTimes(1);
    releaseMoves.mockRestore();
  });
});
