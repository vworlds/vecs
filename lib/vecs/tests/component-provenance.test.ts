import { describe, expect, it, vi } from "vitest";
import { Module, Relationship, Singleton, World } from "../src/index.js";

class Position {}
class Policy {
  value = 0;
}
class OtherPolicy {}
class TraitEdge extends Relationship {}

describe("Component provenance", () => {
  it("keeps the first registrar and reports distinct duplicate module declarations", () => {
    class Owner extends Module {
      public init(): void {
        this.world.component(Position);
        this.world.component(Position);
      }
    }
    class Other extends Module {
      public init(): void {
        this.world.component(Position);
        this.world.component(Position);
      }
    }
    const world = new World();
    world.module(Owner);
    const component = world.component(Position);
    component.name = "Position";
    world.module(Other);
    expect(world.component("Position")).toBe(component);
    expect(component.registeredBy()).toBe(Owner);
    expect(component.registrars()).toEqual([Owner, Other]);
    const snapshot = component.registrars();
    (snapshot as unknown[]).length = 0;
    expect(component.registrars()).toEqual([Owner, Other]);
  });

  it("retains an initial application registration and isolates worlds", () => {
    class Owner extends Module {
      public init(): void {
        this.world.component(Position);
      }
    }
    const world = new World();
    const component = world.component(Position);
    expect(component.registeredBy()).toBeUndefined();
    expect(component.registrars()).toEqual([undefined]);
    world.module(Owner);
    expect(component.registeredBy()).toBeUndefined();
    expect(component.registrars()).toEqual([undefined, Owner]);
    const otherWorld = new World();
    otherWorld.module(Owner);
    expect(otherWorld.component(Position).registeredBy()).toBe(Owner);
  });

  it("records trait declarations by their own module, including per-target edges", () => {
    class Owner extends Module {
      public init(): void {
        this.world.component(Policy);
        this.world.component(OtherPolicy);
        this.world.component(TraitEdge);
        this.world.component(Position).add(Policy).add(TraitEdge, Policy);
      }
    }
    class Other extends Module {
      public init(): void {
        this.world
          .component(Position)
          .set(Policy, { value: 2 })
          .add(OtherPolicy)
          .add(TraitEdge, OtherPolicy);
      }
    }
    const world = new World();
    world.module(Owner);
    world.module(Other);
    const component = world.component(Position);
    expect(component.registeredBy()).toBe(Owner);
    expect(component.traitRegisteredBy(Policy)).toBe(Owner);
    expect(component.get(Policy)?.value).toBe(2);
    expect(component.traitRegisteredBy(OtherPolicy)).toBe(Other);
    expect(component.traitRegisteredBy(TraitEdge, Policy)).toBe(Owner);
    expect(component.traitRegisteredBy(TraitEdge, OtherPolicy)).toBe(Other);
    component.remove(Policy);
    component.add(Policy);
    expect(component.traitRegisteredBy(Policy)).toBe(Owner);
  });

  it("captures set, attach, ensure and deferred trait declarations during init", () => {
    class Attached {}
    class Ensured {}
    class Owner extends Module {
      public init(): void {
        this.world.component(Policy);
        this.world.component(Attached);
        this.world.component(Ensured);
        this.world.component(TraitEdge);
        this.world.component(Position).set(Policy, { value: 1 }).attach(new Attached());
        this.world.component(Position).ensure(Ensured, () => {});
        this.world.component(Position).add(TraitEdge, Policy);
      }
    }
    const world = new World();
    world.defer(() => world.module(Owner));
    const component = world.component(Position);
    expect(component.traitRegisteredBy(Policy)).toBe(Owner);
    expect(component.traitRegisteredBy(Attached)).toBe(Owner);
    expect(component.traitRegisteredBy(Ensured)).toBe(Owner);
    expect(component.traitRegisteredBy(TraitEdge, Policy)).toBe(Owner);
    expect(component.get(Policy)?.value).toBe(1);
    expect(component.has(Attached)).toBe(true);
    expect(component.has(Ensured)).toBe(true);
    expect(component.target(TraitEdge)).toBe(world.component(Policy));
  });

  it("ignores application trait declarations so a later module becomes the first recorded registrar", () => {
    class Owner extends Module {
      public init(): void {
        this.world.component(Position).add(Policy);
      }
    }
    const world = new World();
    world.component(Policy);
    const component = world.component(Position).add(Policy);
    expect(component.traitRegisteredBy(Policy)).toBeUndefined();
    world.module(Owner);
    expect(component.traitRegisteredBy(Policy)).toBe(Owner);
    world.component(OtherPolicy);
    expect(component.traitRegisteredBy(OtherPolicy)).toBeUndefined();
  });

  it("updates singleton data per tick without extra component resolution or trait provenance", () => {
    class Clock {
      value = 0;
    }
    const world = new World();
    const clock = world.component(Clock).add(Singleton);
    world.system("clock").run((now) => {
      world.set(Clock, { value: now });
    });
    world.progress(0, 16); // finish query builds before measuring runtime resolution
    const resolve = vi.spyOn(world, "entity");
    try {
      for (let tick = 1; tick <= 3; tick++) {
        world.progress(tick, 16);
      }
      expect(resolve).toHaveBeenCalledTimes(3); // only the underlying Entity.set resolution
    } finally {
      resolve.mockRestore();
    }
    expect(world.get(Clock)?.value).toBe(3);
    expect(clock.traitRegisteredBy(Clock)).toBeUndefined();
    expect(clock.traitRegisteredBy(Singleton)).toBeUndefined();
  });

  it.each(["add", "set", "attach"] as const)(
    "forwards application %s with only the underlying entity resolution",
    (method) => {
      const world = new World();
      world.component(Policy);
      const component = world.component(Position);
      const resolve = vi.spyOn(world, "entity");
      try {
        if (method === "add") {
          component.add(Policy);
        } else if (method === "set") {
          component.set(Policy, { value: 2 });
        } else {
          component.attach(new Policy());
        }
        expect(resolve).toHaveBeenCalledTimes(1);
      } finally {
        resolve.mockRestore();
      }
      expect(component.has(Policy)).toBe(true);
      expect(component.traitRegisteredBy(Policy)).toBeUndefined();
      class Owner extends Module {
        public init(): void {
          this.world.component(Position).add(Policy);
        }
      }
      world.module(Owner);
      expect(component.traitRegisteredBy(Policy)).toBe(Owner);
    }
  );

  for (const deferred of [false, true]) {
    it.each(["add", "set", "attach", "ensure"] as const)(
      `does not record singleton self-data via %s during ${deferred ? "deferred" : "synchronous"} init`,
      (method) => {
        class State {
          value = 0;
        }
        class Owner extends Module {
          public init(): void {
            const state = this.world.component(State).add(Singleton);
            if (method === "add") {
              state.add(State);
            } else if (method === "set") {
              this.world.set(State, { value: 1 });
            } else if (method === "attach") {
              state.attach(new State());
            } else {
              state.ensure(State, (value) => {
                value.value = 1;
              });
            }
          }
        }
        const world = new World();
        if (deferred) {
          world.defer(() => world.module(Owner));
        } else {
          world.module(Owner);
        }
        const state = world.component(State);
        expect(state.has(State)).toBe(true);
        expect(state.registeredBy()).toBe(Owner);
        expect(state.traitRegisteredBy(Singleton)).toBe(Owner);
        expect(state.traitRegisteredBy(State)).toBeUndefined();
      }
    );
  }

  it("restores nested init context, even when an inner module throws", () => {
    class Before {}
    class InnerComponent {}
    class After {}
    class Outside {}
    class Inner extends Module {
      public init(): void {
        this.world.component(InnerComponent);
        throw new Error("init failed");
      }
    }
    class Outer extends Module {
      public init(): void {
        this.world.component(Before);
        expect(() => this.world.module(Inner)).toThrow("init failed");
        this.world.component(After);
      }
    }
    const world = new World();
    world.module(Outer);
    expect(world.component(Before).registeredBy()).toBe(Outer);
    expect(world.component(InnerComponent).registeredBy()).toBe(Inner);
    expect(world.component(After).registeredBy()).toBe(Outer);
    expect(world.component(Outside).registeredBy()).toBeUndefined();
  });

  it("attributes successful nested modules independently and restores the outer trait registrar", () => {
    class InnerComponent {}
    class After {}
    class Inner extends Module {
      public init(): void {
        this.world.component(InnerComponent);
      }
    }
    class Outer extends Module {
      public init(): void {
        this.world.component(Policy);
        this.world.component(Position);
        this.world.module(Inner);
        this.world.module(Inner); // idempotent install must not change context
        this.world.component(Position).add(Policy);
        this.world.component(After);
      }
    }
    const world = new World();
    world.module(Outer);
    expect(world.component(Position).registeredBy()).toBe(Outer);
    expect(world.component(Position).traitRegisteredBy(Policy)).toBe(Outer);
    expect(world.component(InnerComponent).registeredBy()).toBe(Inner);
    expect(world.component(After).registeredBy()).toBe(Outer);
  });

  it("restores application context after an outer init throws", () => {
    class Broken extends Module {
      public init(): void {
        throw new Error("broken");
      }
    }
    const world = new World();
    expect(() => world.module(Broken)).toThrow("broken");
    expect(world.component(Position).registeredBy()).toBeUndefined();
    expect(world.component(Position).registrars()).toEqual([undefined]);
  });
});
