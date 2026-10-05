import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

import {
  AngularVelocity,
  Body,
  BodyType,
  Box,
  LinearVelocity,
  PhysicsModule,
  Position,
  Rotation,
} from "../../src/index.js";
import { getPhysicsEngine } from "../../src/adapter/engine.js";

type Handle = { delete: () => void };

function isHandle(value: unknown): value is Handle {
  return typeof value === "object" && value !== null && "delete" in value;
}

describe("PhysicsPoseSyncOut Embind handles", () => {
  it("creates five handles per moved body and reads each struct view once", () => {
    const world = new World();
    world.module(PhysicsModule, { gravity: { x: 0, y: -3 } });
    const engine = getPhysicsEngine(world);
    const bodyCount = 4;
    for (let i = 0; i < bodyCount; i++) {
      world
        .entity()
        .set(Body, { type: BodyType.Dynamic })
        .set(Position, { x: i * 2, y: 5 })
        .set(Rotation, { angle: 0.2 })
        .set(LinearVelocity, { x: 1, y: 1 })
        .set(AngularVelocity, { value: 1 })
        .set(Box, { width: 1, height: 1 });
    }
    world.progress(0, 16);

    // Count every class handle the body-events API hands out while the system runs.
    const box2d = engine.box2d as unknown as Record<string, (...args: unknown[]) => unknown>;
    const handleCounts = new Map<string, number>();
    const patched = new Set<object>();
    const track = (name: string, value: unknown): unknown => {
      if (isHandle(value)) {
        handleCounts.set(name, (handleCounts.get(name) ?? 0) + 1);
        patchPrototypeChain(Object.getPrototypeOf(value));
      }
      return value;
    };
    const patchPrototypeChain = (proto: object | null): void => {
      if (proto === null || proto === Object.prototype || patched.has(proto)) {
        return;
      }
      patched.add(proto);
      patchPrototypeChain(Object.getPrototypeOf(proto));
      for (const key of Object.getOwnPropertyNames(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key)!;
        if (descriptor.get !== undefined) {
          const getter = descriptor.get;
          Object.defineProperty(proto, key, {
            ...descriptor,
            get(this: unknown) {
              return track(key, getter.call(this));
            },
          });
        } else if (
          typeof descriptor.value === "function" &&
          !["constructor", "delete", "isDeleted", "clone", "isAliasOf"].includes(key) &&
          !key.startsWith("deleteLater") &&
          !key.startsWith("isDeletedLater")
        ) {
          const method = descriptor.value as (...args: unknown[]) => unknown;
          Object.defineProperty(proto, key, {
            ...descriptor,
            value(this: unknown, ...args: unknown[]) {
              return track(key, method.apply(this, args));
            },
          });
        }
      }
    };

    let moves = 0;
    for (const name of ["b2World_GetBodyEvents", "b2Body_GetLinearVelocity"]) {
      const original = box2d[name];
      box2d[name] = (...args: unknown[]) => {
        const result = track(name, original.apply(box2d, args)) as { moveCount?: number };
        moves += result?.moveCount ?? 0;
        return result;
      };
    }

    const ticks = 5;
    for (let tick = 1; tick <= ticks; tick++) {
      world.progress(tick * 16, 16);
    }

    expect(moves).toBe(bodyCount * ticks);
    expect(handleCounts.get("GetMoveEvent")).toBe(moves);
    expect(handleCounts.get("transform")).toBe(moves);
    expect(handleCounts.get("p")).toBe(moves);
    expect(handleCounts.get("q")).toBe(moves);
    expect(handleCounts.get("b2Body_GetLinearVelocity")).toBe(moves);
  });
});
