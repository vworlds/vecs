import { describe, expect, it, vi } from "vitest";
import {
  type ComponentClass,
  type EID,
  type Entity,
  CleanupPolicy,
  Exclusive,
  Identity,
  Module,
  OneOf,
  OwnedTarget,
  Phase,
  Relationship,
  Singleton,
  Traversable,
  With,
  World,
} from "../src/index.js";

class Handle {}
class Marker {}
class Owns extends Relationship {}
class ParentOf extends Relationship {}
class ResidesIn extends Relationship {}
class WornBy extends Relationship {}
class OwnedBy extends Relationship {}

const CALL_SITE_ERROR =
  "dispose() must be called outside progress(), defer, a command drain or an entity's destroy";

/** Count the `remove` hook calls `Class` receives, keyed by the id of the entity they fired for. */
function countRemovals(world: World, Class: ComponentClass): Map<EID, number> {
  const removals = new Map<EID, number>();
  world
    .component(Class)
    .on("remove", (entity) => removals.set(entity.eid, (removals.get(entity.eid) ?? 0) + 1));
  return removals;
}

/** The ids of every entity in `world`, sorted. */
function entityIds(world: World): EID[] {
  return world.entities
    .values()
    .map((entity) => entity.eid)
    .sort((a, b) => a - b);
}

describe("World.dispose", () => {
  it("keeps application remove hooks during the infrastructure pass without cascading Delete policies", () => {
    class Tag {}
    const world = new World();
    world.component(Tag).onDelete = CleanupPolicy.Delete;
    const removed: EID[] = [];
    world.component(Tag).on("remove", (entity) => removed.push(entity.eid));
    const survivor = world.entity().add(Tag);
    const key = world.component(Tag);
    // The key's own destruction would cascade-delete its carriers under `Delete`; only the
    // carrier's own removal may fire the hook, exactly once.
    world.dispose();
    expect(removed).toEqual([survivor.eid]);
    expect(key.meta.onDelete).toBe(CleanupPolicy.Remove);
  });

  describe("application entities", () => {
    it("fires a remove hook on a local component exactly once", () => {
      const w = new World();
      const removals = countRemovals(w, Handle);
      const first = w.entity().add(Handle);
      const second = w.entity().add(Handle);

      w.dispose();

      expect(removals).toEqual(
        new Map([
          [first.eid, 1],
          [second.eid, 1],
        ])
      );
      expect(first.destroyed).toBe(true);
      expect(second.destroyed).toBe(true);
    });

    it("destroys every entity the application created, bare and named ones included", () => {
      const w = new World();
      w.component(Marker);
      const bare = w.entity();
      const named = w.entity("player");
      const withData = w.entity().add(Marker);

      w.dispose();

      expect([bare, named, withData].map((entity) => entity.destroyed)).toEqual([true, true, true]);
      expect(w.getEntity("player")).toBeUndefined();
      expect(w.getEntity(bare.eid)).toBeUndefined();
    });

    it("destroys an entity once when a hook has already destroyed it", () => {
      const w = new World();
      const partners = new Map<EID, Entity>();
      const removals = new Map<EID, number>();
      w.component(Handle).on("remove", (entity) => {
        removals.set(entity.eid, (removals.get(entity.eid) ?? 0) + 1);
        partners.get(entity.eid)?.destroy();
      });
      const first = w.entity().add(Handle);
      const second = w.entity().add(Handle);
      partners.set(first.eid, second).set(second.eid, first);

      expect(() => w.dispose()).not.toThrow();

      expect(removals).toEqual(
        new Map([
          [first.eid, 1],
          [second.eid, 1],
        ])
      );
    });

    it("destroys a ChildOf tree once, whichever entity it reaches first", () => {
      const w = new World();
      const removals = countRemovals(w, Handle);
      const leaf = w.entity().add(Handle);
      const branch = w.entity().add(Handle);
      const root = w.entity().add(Handle);
      leaf.childOf(branch);
      branch.childOf(root);

      w.dispose();

      expect(removals).toEqual(
        new Map([
          [leaf.eid, 1],
          [branch.eid, 1],
          [root.eid, 1],
        ])
      );
      expect([leaf, branch, root].every((entity) => entity.destroyed)).toBe(true);
    });

    it("destroys an OwnedTarget and its owner once each", () => {
      const w = new World();
      w.component(Owns).add(Exclusive).add(OwnedTarget);
      const removals = countRemovals(w, Handle);
      const owner = w.entity().add(Handle);
      const owned = w.entity().add(Handle);
      owner.add(Owns, owned);

      expect(() => w.dispose()).not.toThrow();

      expect(removals).toEqual(
        new Map([
          [owner.eid, 1],
          [owned.eid, 1],
        ])
      );
      expect(owner.destroyed).toBe(true);
      expect(owned.destroyed).toBe(true);
      expect(w.getEntity(Owns)).toBeUndefined();
    });

    it("destroys an entity used as a component key after the entities that carry it", () => {
      const w = new World();
      // Created first, so a sweep in creation order would reach it while it is still in use.
      const key = w.entity();
      const first = w.entity().add(key);
      const second = w.entity().add(key);

      expect(() => w.dispose()).not.toThrow();

      expect([key, first, second].every((entity) => entity.destroyed)).toBe(true);
    });

    it("orders a chain of component keys, each after what carries it", () => {
      const w = new World();
      const innermost = w.entity();
      const middle = w.entity().add(innermost);
      const outermost = w.entity().add(middle);
      const carrier = w.entity().add(outermost);

      expect(() => w.dispose()).not.toThrow();

      expect([innermost, middle, outermost, carrier].every((entity) => entity.destroyed)).toBe(
        true
      );
    });
  });

  describe("infrastructure", () => {
    it("reports an internal invariant instead of spinning on a registered destroyed entity", () => {
      const world = new World();
      const broken = world.component(Handle);
      const corrupt = vi.spyOn(broken, "destroyed", "get").mockReturnValue(true);
      try {
        expect(() => world.dispose()).toThrow(
          `Internal invariant: infrastructure teardown made no progress; registered entities: ${broken.eid} (Handle, destroyed=true)`
        );
      } finally {
        corrupt.mockRestore();
      }
    });

    it("reports no progress if a broken destroy returns without destroying its entity", () => {
      const world = new World();
      const broken = world.component(Handle);
      const noOp = vi.spyOn(broken, "_destroy").mockImplementation(() => {});
      try {
        expect(() => world.dispose()).toThrow(
          `Internal invariant: infrastructure teardown made no progress; registered entities: ${broken.eid} (Handle, destroyed=false)`
        );
      } finally {
        noOp.mockRestore();
      }
    });

    it("destroys module parents without cascading into still-carried children", () => {
      class Resource {}
      class Carrier {}
      class Feature extends Module {
        public init(): void {
          this.world.component(Resource).set(Resource, {});
          this.world.component(Carrier).add(Resource);
        }
      }
      const world = new World();
      const feature = world.module(Feature);
      const resource = world.component(Resource);
      const carrier = world.component(Carrier);
      const removed = countRemovals(world, Resource);
      const order: string[] = [];
      world.component(Handle).on("remove", () => {
        expect(resource.alive).toBe(true);
        expect(carrier.alive).toBe(true);
        order.push("module");
      });
      feature.add(Handle);
      resource.on("remove", () => order.push("resource"));
      expect(resource.parent).toBe(feature);
      expect(() => world.dispose()).not.toThrow();
      expect(order[0]).toBe("module");
      expect(removed).toEqual(
        new Map([
          [resource.eid, 1],
          [carrier.eid, 1],
        ])
      );
      expect(entityIds(world)).toEqual([]);
    });

    it("suspends every relationship cleanup policy for infrastructure only", () => {
      const world = new World();
      const owner = world.component(Handle);
      const target = world.component(Marker);
      world.component(Owns).add(Exclusive).add(OwnedTarget);
      world.component(ParentOf).add(Exclusive).add(Traversable);
      world.component(ResidesIn).add(OneOf, owner);
      world.component(OwnedBy);
      world.component(WornBy).add(With, OwnedBy);
      target.childOf(owner);
      owner.add(Owns, target).add(ParentOf, target).add(ResidesIn, target).add(WornBy, target);
      owner.meta.onDelete = CleanupPolicy.Delete;
      const carrier = world.component(class Carrier {}).add(owner);
      const removals = countRemovals(world, Handle);
      expect(() => world.dispose()).not.toThrow();
      expect(removals).toEqual(new Map([[carrier.eid, 1]]));
      expect(entityIds(world)).toEqual([]);
    });

    it("destroys queries and systems before releasing component data they read", () => {
      const w = new World();
      const component = w.component(Handle);
      const system = w.system("Reader").with(Handle);
      const query = w.query("ReaderQuery").with(Handle).track();
      w.set(Handle, {});
      let calls = 0;
      component.on("remove", () => {
        calls++;
        expect(system.entity.destroyed).toBe(true);
        expect(query.entity.destroyed).toBe(true);
      });
      w.dispose();
      expect(calls).toBe(1);
    });

    it("strips infrastructure carriers instead of overriding reverse module order", () => {
      class First extends Module {
        public init(): void {}
      }
      class Second extends Module {
        public init(): void {}
      }
      const w = new World();
      const events: EID[] = [];
      w.component(Handle).on("remove", (entity) => events.push(entity.eid));
      const first = w.module(First).add(Handle);
      const second = w.module(Second).add(Handle);
      first.add(second);
      expect(() => w.dispose()).not.toThrow();
      expect(events).toEqual([second.eid, first.eid]);
      expect(entityIds(w)).toEqual([]);
    });

    it("removes modules in reverse registration order, independent of ids and entity-map swaps", () => {
      class First extends Module {
        public init(): void {}
      }
      class Second extends Module {
        public init(): void {}
      }
      const w = new World();
      const events: EID[] = [];
      w.component(Handle).on("remove", (entity) => events.push(entity.eid));
      const bare = w.entity();
      const first = w.module(First, 890).add(Handle);
      const second = w.module(Second, 889).add(Handle);
      bare.destroy();
      w.dispose();
      expect(events).toEqual([second.eid, first.eid]);
    });

    it("releases module component data and singletons after all application hooks", () => {
      class Resource {}
      class Feature extends Module {
        public init(): void {
          this.world.component(Resource).set(Resource, {});
        }
      }
      const w = new World();
      const events: string[] = [];
      w.module(Feature);
      w.component(Resource).on("remove", () => events.push("resource"));
      w.component(Handle).on("remove", () => events.push("application"));
      w.entity().add(Handle);
      w.entity().add(Handle);
      w.dispose();
      w.dispose();
      expect(events).toEqual(["application", "application", "resource"]);
      expect(entityIds(w)).toEqual([]);
    });

    it("strips cyclic infrastructure carriers with exactly one remove per instance", () => {
      const w = new World();
      const first = w.component(Handle);
      const second = w.component(Marker);
      first.add(second);
      second.add(first);
      const handles = countRemovals(w, Handle);
      const markers = countRemovals(w, Marker);
      expect(() => w.dispose()).not.toThrow();
      expect(handles).toEqual(new Map([[second.eid, 1]]));
      expect(markers).toEqual(new Map([[first.eid, 1]]));
      expect(entityIds(w)).toEqual([]);
    });

    it("destroys component, module, system, query and phase entities", () => {
      class Feature extends Module {
        public init(): void {}
      }
      const w = new World();
      const component = w.component(Marker);
      const feature = w.module(Feature);
      const system = w
        .system("Mover")
        .with(Marker)
        .run(() => {});
      const query = w.query("Markers").with(Marker).track();
      const phase = w.entity("custom-phase").add(Phase);
      w.flush();
      const player = w.entity("player").add(Marker);
      const bare = w.entity();

      w.dispose();

      expect(entityIds(w)).toEqual([]);
      expect([component, feature, system.entity, query.entity, phase].map((e) => e.alive)).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(w.queries.includes(system)).toBe(false);
      expect(w.queries.includes(query)).toBe(false);
      expect(w.getEntity(Marker)).toBeUndefined();
      expect([player, bare].map((entity) => entity.destroyed)).toEqual([true, true]);
    });

    it("tears down configured relationship traits and live edges", () => {
      const w = new World();
      w.component(Owns).add(Exclusive).add(OwnedTarget);
      w.component(ParentOf).add(Exclusive).add(Traversable);
      w.component(WornBy).add(With, w.component(OwnedBy));
      // The OneOf parent is an application entity, so the trait's own edge is torn down too.
      const region = w.entity();
      w.component(ResidesIn).add(OneOf, region);
      const forest = w.entity().childOf(region);
      const resident = w.entity().add(ResidesIn, forest);
      const owner = w.entity();
      const owned = w.entity();
      owner.add(Owns, owned);
      const root = w.entity();
      const child = w.entity().add(ParentOf, root);
      const wearer = w.entity();
      const worn = w.entity().add(WornBy, wearer);
      const application = [region, forest, resident, owner, owned, root, child, wearer, worn];

      expect(() => w.dispose()).not.toThrow();

      expect(application.every((entity) => entity.destroyed)).toBe(true);
      expect(entityIds(w)).toEqual([]);
    });

    it("destroys the built-in pipeline phases", () => {
      const w = new World();
      const phases = w.entities.values().filter((entity) => entity.has(Phase));
      expect(phases.length).toBeGreaterThan(0);

      w.dispose();

      expect(phases.every((phase) => phase.destroyed)).toBe(true);
    });

    it("destroys a component key after its infrastructure carrier", () => {
      const w = new World();
      const trait = w.entity("trait");
      w.component(Marker).add(trait);
      const user = w.entity().add(Marker);

      expect(() => w.dispose()).not.toThrow();

      expect(trait.destroyed).toBe(true);
      expect(w.getEntity(Marker)).toBeUndefined();
      expect(user.destroyed).toBe(true);
    });

    it("removes singleton data stored on a component entity exactly once", () => {
      const w = new World();
      const removals = countRemovals(w, Handle);
      w.component(Handle).add(Singleton);
      w.set(Handle, {});
      const component = w.entity(Handle);

      w.dispose();

      expect(w.getEntity(Handle)).toBeUndefined();
      expect(removals).toEqual(new Map([[component.eid, 1]]));
    });

    it("tolerates a world that clearAllEntities() already emptied", () => {
      const w = new World();
      w.entity();
      w.clearAllEntities();
      const later = w.entity();

      expect(() => w.dispose()).not.toThrow();

      expect(later.destroyed).toBe(true);
    });
  });

  describe("idempotence", () => {
    it("is a no-op the second time", () => {
      const w = new World();
      const removals = countRemovals(w, Handle);
      w.entity().add(Handle);
      w.dispose();
      expect(removals.size).toBe(1);

      // A disposed world must not be used again. This entity only shows that the second call
      // does nothing: it would otherwise be destroyed.
      const late = w.entity();

      expect(() => w.dispose()).not.toThrow();
      expect(late.destroyed).toBe(false);
      expect(removals.size).toBe(1);
    });

    it("rejects a dispose() re-entered from a teardown hook", () => {
      const w = new World();
      let calls = 0;
      w.component(Handle).on("remove", () => {
        calls++;
        expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
      });
      w.entity().add(Handle);
      w.entity().add(Handle);

      expect(() => w.dispose()).not.toThrow();

      expect(calls).toBe(2);
    });
  });

  describe("call sites and hook commands", () => {
    it.each(["add", "set", "remove"] as const)(
      "refuses a %s hook during a command drain and keeps the world usable",
      (event) => {
        const w = new World();
        const component = w.component(Handle);
        const entity = w.entity();
        if (event !== "add") {
          entity.add(Handle);
        }
        let calls = 0;
        const refused = (): void => {
          calls++;
          expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
        };
        component.on(event, refused);
        w.defer(() => {
          if (event === "add") {
            entity.add(Handle);
          } else if (event === "set") {
            entity.set(Handle, {});
          } else {
            entity.remove(Handle);
          }
        });
        expect(calls).toBe(1);
        component.off(event, refused);
        entity.set(Handle, {});
        expect(entity.get(Handle)).toEqual(new Handle());
        w.dispose();
        expect(entity.destroyed).toBe(true);
        expect(entityIds(w)).toEqual([]);
      }
    );

    it("refuses an explicitly open frame", () => {
      const w = new World();
      const entity = w.entity();
      w.beginFrame(0);
      expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
      expect(entity.alive).toBe(true);
      w.endFrame();
      w.dispose();
      expect(entity.destroyed).toBe(true);
      expect(entityIds(w)).toEqual([]);
    });

    it("rejects disposal from a remove hook in a command drain", () => {
      const w = new World();
      const events: string[] = [];
      w.component(Handle).on("remove", () => {
        events.push("first");
        expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
      });
      w.component(Marker).on("remove", () => events.push("remaining"));
      const entity = w.entity().add(Handle).add(Marker);
      expect(() => w.defer(() => entity.destroy())).not.toThrow();
      expect(events).toEqual(["first", "remaining"]);
      expect(w.entity().alive).toBe(true);
      w.dispose();
      expect(entityIds(w)).toEqual([]);
    });

    it("settles commands from an infrastructure hook before destroying their component keys", () => {
      class Feature extends Module {
        public init(): void {}
      }
      const w = new World();
      const events: string[] = [];
      const target = w.component(Marker).set(Marker, {});
      target.on("remove", () => events.push("target"));
      w.component(Handle).on("remove", () => {
        w.defer(() => target.remove(Marker));
        expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
        events.push("module");
      });
      const feature = w.module(Feature).add(Handle);
      w.dispose();
      expect(feature.destroyed).toBe(true);
      expect(events).toEqual(["target", "module"]);
      expect(entityIds(w)).toEqual([]);
    });

    it("refuses an otherwise empty deferred scope without starting disposal", () => {
      const w = new World();
      const component = w.component(Handle);
      w.defer(() => {
        expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
        expect(component.alive).toBe(true);
      });
      expect(w.entity().alive).toBe(true);
      w.dispose();
      expect(entityIds(w)).toEqual([]);
    });

    it.each([false, true])(
      "refuses systems without changing infrastructure (later throw: %s)",
      (throws) => {
        const w = new World();
        const events: string[] = [];
        const component = w.component(Handle).on("remove", () => events.push("resource"));
        w.set(Handle, {});
        const quit = w.system("Quit").run(() => {
          expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
          expect(component.alive).toBe(true);
        });
        const later = w.system("Later").run(() => {
          expect(component.alive).toBe(true);
          expect(quit.entity.alive).toBe(true);
          events.push("later");
          expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
          if (throws) {
            throw new Error("later failure");
          }
        });
        if (throws) {
          expect(() => w.progress(0, 0)).toThrow("later failure");
        } else {
          w.progress(0, 0);
        }
        expect(events).toEqual(["later"]);
        expect(w.entity().alive).toBe(true);
        w.dispose();
        expect(events).toEqual(["later", "resource"]);
        expect(later.entity.destroyed).toBe(true);
        expect(entityIds(w)).toEqual([]);
      }
    );

    it("settles application hook-generated commands before synchronous infrastructure teardown", () => {
      const w = new World();
      const events: string[] = [];
      const component = w.component(Handle);
      w.component(Marker).on("remove", () => {
        w.entity().add(Handle);
        events.push("application");
      });
      component.on("remove", () => events.push("handle"));
      w.set(Handle, {});
      w.entity().add(Marker);
      w.dispose();
      expect(events[0]).toBe("application");
      expect(events.filter((e) => e === "handle")).toHaveLength(2);
      expect(entityIds(w)).toEqual([]);
    });

    it("refuses disposal during a synchronous destroy without starting it", () => {
      const w = new World();
      const events: string[] = [];
      const first = w.component(Handle).on("remove", () => {
        events.push("first");
        expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
        expect(remaining.alive).toBe(true);
      });
      const remaining = w.component(Marker).on("remove", () => events.push("remaining"));
      const entity = w.entity().add(Handle).add(Marker);
      expect(() => entity.destroy()).not.toThrow();
      expect(events).toEqual(["first", "remaining"]);
      expect(first.alive).toBe(true);
      expect(remaining.alive).toBe(true);
      expect(w.entity().alive).toBe(true);
      w.dispose();
      expect(first.destroyed).toBe(true);
      expect(remaining.destroyed).toBe(true);
      expect(entityIds(w)).toEqual([]);
    });

    it.each(["ChildOf", "OwnedTarget"])(
      "refuses nested %s cascade hooks, then tears down infrastructure at top level",
      (relationship) => {
        const w = new World();
        const removals = new Map<EID, number>();
        const events: string[] = [];
        const resource = w.component(Marker).set(Marker, {});
        resource.on("remove", () => events.push("resource"));
        w.component(Handle).on("remove", (entity) => {
          removals.set(entity.eid, (removals.get(entity.eid) ?? 0) + 1);
          events.push(`application:${entity.eid}`);
          expect(resource.alive).toBe(true);
          if (entity === leaf) {
            expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
          }
        });
        const root = w.entity().add(Handle);
        const middle = w.entity().add(Handle);
        const leaf = w.entity().add(Handle);
        if (relationship === "ChildOf") {
          middle.childOf(root);
          leaf.childOf(middle);
        } else {
          w.component(Owns).add(Exclusive).add(OwnedTarget);
          root.add(Owns, middle);
          middle.add(Owns, leaf);
        }
        expect(() => root.destroy()).not.toThrow();
        expect(removals).toEqual(new Map([root, middle, leaf].map((entity) => [entity.eid, 1])));
        expect(events).toHaveLength(3);
        expect(w.entity().alive).toBe(true);
        w.dispose();
        expect(events).toHaveLength(4);
        expect(events.at(-1)).toBe("resource");
        expect(entityIds(w)).toEqual([]);
      }
    );

    it("refuses disposal throughout cleanup ops without disrupting later cascades", () => {
      const w = new World();
      const events: string[] = [];
      w.component(Owns).add(Exclusive).add(OwnedTarget);
      const resource = w.component(Marker).set(Marker, {});
      resource.on("remove", () => events.push("resource"));
      const root = w.entity();
      w.component(Handle);
      const target = w.entity().add(Handle);
      const child = w.entity().add(Handle).childOf(root);
      root.add(Owns, target);
      w.component(Handle).on("remove", (entity) => {
        events.push(entity === target ? "target" : "child");
        expect(resource.alive).toBe(true);
        expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);
      });
      expect(() => root.destroy()).not.toThrow();
      expect(events).toEqual(["target", "child"]);
      expect(w.entity().alive).toBe(true);
      w.dispose();
      expect(events).toEqual(["target", "child", "resource"]);
      expect(entityIds(w)).toEqual([]);
    });

    it("strips blocked named keys during the final teardown sweep", () => {
      const w = new World();
      const first = w.entity("first-key");
      const second = w.entity("second-key");
      first.add(second);
      second.add(first);
      const identity = w.entity(Identity);
      expect(() => w.dispose()).not.toThrow();
      expect([first, second, identity].every((entity) => entity.destroyed)).toBe(true);
      expect(entityIds(w)).toEqual([]);
    });

    it("disposes from a synchronous remove hook without repeating its hook", () => {
      const w = new World();
      const events: string[] = [];
      w.component(Handle).on("remove", () => {
        events.push("first");
        w.dispose();
      });
      w.component(Marker).on("remove", () => events.push("remaining"));
      const entity = w.entity().add(Handle).add(Marker);
      expect(() => entity.remove(Handle)).not.toThrow();
      expect(events).toEqual(["first", "remaining"]);
      expect(entityIds(w)).toEqual([]);
    });

    it("refuses defer without disturbing queued commands, then tears down at top level", () => {
      const w = new World();
      const removals = countRemovals(w, Handle);
      const existing = w.entity().add(Handle);
      let created!: Entity;

      w.defer(() => {
        existing.remove(Handle);
        created = w.entity().add(Handle);

        expect(() => w.dispose()).toThrow(CALL_SITE_ERROR);

        // Nothing changes until the scope closes.
        expect(existing.destroyed).toBe(false);
        expect(created.destroyed).toBe(false);
      });

      expect(existing.destroyed).toBe(false);
      expect(created.get(Handle)).toEqual(new Handle());
      w.dispose();

      expect(existing.destroyed).toBe(true);
      expect(created.destroyed).toBe(true);
      expect(removals).toEqual(
        new Map([
          [existing.eid, 1],
          [created.eid, 1],
        ])
      );
    });

    it("leaves entities usable after refusing a system call", () => {
      const w = new World();
      w.component(Marker);
      const removals = countRemovals(w, Handle);
      const entity = w.entity().add(Handle);
      w.system("Quit").run(() => expect(() => w.dispose()).toThrow(CALL_SITE_ERROR));

      w.progress(0, 0);

      expect(entity.alive).toBe(true);
      entity.add(Marker);
      expect(entity.has(Marker)).toBe(true);
      w.dispose();

      expect(entity.destroyed).toBe(true);
      expect(removals).toEqual(new Map([[entity.eid, 1]]));
    });

    it("preserves component keys and carriers after refusing a deferred call", () => {
      const w = new World();
      const key = w.entity();
      const carrier = w.entity().add(key);

      expect(() => w.defer(() => w.dispose())).toThrow(CALL_SITE_ERROR);
      expect(key.alive).toBe(true);
      expect(carrier.has(key)).toBe(true);
      w.dispose();

      expect(key.destroyed).toBe(true);
      expect(carrier.destroyed).toBe(true);
    });
  });
});
