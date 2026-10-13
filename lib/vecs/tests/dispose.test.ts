import { describe, expect, it } from "vitest";
import {
  type ComponentClass,
  type EID,
  type Entity,
  Exclusive,
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

    it("gives carrier dependencies precedence when reverse module order is impossible", () => {
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
      expect(events).toEqual([first.eid, second.eid]);
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

    it("skips cycles but destroys unrelated infrastructure", () => {
      const w = new World();
      const first = w.component(Handle);
      const second = w.component(Marker);
      first.add(second);
      second.add(first);
      expect(() => w.dispose()).not.toThrow();
      expect(entityIds(w)).toEqual([first.eid, second.eid].sort((a, b) => a - b));
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

    it("ignores a dispose() called from a remove hook", () => {
      const w = new World();
      let calls = 0;
      w.component(Handle).on("remove", () => {
        calls++;
        w.dispose();
      });
      w.entity().add(Handle);
      w.entity().add(Handle);

      expect(() => w.dispose()).not.toThrow();

      expect(calls).toBe(2);
    });
  });

  describe("pending commands", () => {
    it("fully disposes when a remove hook initiates disposal inside defer", () => {
      const w = new World();
      const events: string[] = [];
      w.component(Handle).on("remove", () => {
        events.push("first");
        w.dispose();
        w.dispose();
      });
      w.component(Marker).on("remove", () => events.push("remaining"));
      const entity = w.entity().add(Handle).add(Marker);
      expect(() => w.defer(() => entity.destroy())).not.toThrow();
      expect(events).toEqual(["first", "remaining"]);
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
        w.dispose();
        events.push("module");
      });
      const feature = w.module(Feature).add(Handle);
      w.dispose();
      expect(feature.destroyed).toBe(true);
      expect(events).toEqual(["target", "module"]);
      expect(entityIds(w)).toEqual([]);
    });

    it("finishes after an otherwise empty deferred scope", () => {
      const w = new World();
      const component = w.component(Handle);
      w.defer(() => {
        w.dispose();
        expect(component.alive).toBe(true);
      });
      expect(entityIds(w)).toEqual([]);
    });

    it.each([false, true])(
      "keeps infrastructure until the tick ends (later throw: %s)",
      (throws) => {
        const w = new World();
        const events: string[] = [];
        const component = w.component(Handle).on("remove", () => events.push("resource"));
        w.set(Handle, {});
        const quit = w.system("Quit").run(() => {
          w.dispose();
          w.dispose();
          expect(component.alive).toBe(true);
        });
        const later = w.system("Later").run(() => {
          expect(component.alive).toBe(true);
          expect(quit.entity.alive).toBe(true);
          events.push("later");
          w.dispose();
          if (throws) {
            throw new Error("later failure");
          }
        });
        if (throws) {
          expect(() => w.progress(0, 0)).toThrow("later failure");
        } else {
          w.progress(0, 0);
        }
        expect(events).toEqual(["later", "resource"]);
        expect(later.entity.destroyed).toBe(true);
        expect(entityIds(w)).toEqual([]);
      }
    );

    it("finishes after an enclosing defer drains hook-generated commands", () => {
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
      w.defer(() => {
        w.dispose();
        w.dispose();
        expect(component.alive).toBe(true);
      });
      expect(events[0]).toBe("application");
      expect(events.filter((e) => e === "handle")).toHaveLength(2);
      expect(entityIds(w)).toEqual([]);
    });

    it("skips keys still carried by a synchronous destroy already on the stack", () => {
      const w = new World();
      const events: string[] = [];
      const first = w.component(Handle).on("remove", () => {
        events.push("first");
        w.dispose();
      });
      const remaining = w.component(Marker).on("remove", () => events.push("remaining"));
      const entity = w.entity().add(Handle).add(Marker);
      expect(() => entity.destroy()).not.toThrow();
      expect(events).toEqual(["first", "remaining"]);
      expect(first.destroyed).toBe(true);
      expect(remaining.alive).toBe(true);
      expect(entityIds(w)).toEqual([remaining.eid]);
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

    it("runs the queued commands first, then the teardown, firing each hook once", () => {
      const w = new World();
      const removals = countRemovals(w, Handle);
      const existing = w.entity().add(Handle);
      let created!: Entity;

      w.defer(() => {
        existing.remove(Handle);
        created = w.entity().add(Handle);

        w.dispose();

        // Nothing changes until the scope closes.
        expect(existing.destroyed).toBe(false);
        expect(created.destroyed).toBe(false);
      });

      expect(existing.destroyed).toBe(true);
      expect(created.destroyed).toBe(true);
      expect(removals).toEqual(
        new Map([
          [existing.eid, 1],
          [created.eid, 1],
        ])
      );
    });

    it("completes when a system calls it, once the system's commands flush", () => {
      const w = new World();
      const removals = countRemovals(w, Handle);
      const entity = w.entity().add(Handle);
      w.system("Quit").run(() => w.dispose());

      w.progress(0, 0);

      expect(entity.destroyed).toBe(true);
      expect(removals).toEqual(new Map([[entity.eid, 1]]));
    });

    it("orders component keys after their carriers inside a deferred scope too", () => {
      const w = new World();
      const key = w.entity();
      const carrier = w.entity().add(key);

      expect(() => w.defer(() => w.dispose())).not.toThrow();

      expect(key.destroyed).toBe(true);
      expect(carrier.destroyed).toBe(true);
    });
  });
});
