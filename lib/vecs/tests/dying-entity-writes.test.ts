import { describe, expect, it, vi } from "vitest";
import { type Entity, Implements, Relationship, World } from "../src/index.js";

class Trigger {}
class Present {
  value = 1;
}
class Missing {
  value = 0;
}
class LinkedTo extends Relationship {}
class Alias {}

describe("writes on a dying entity", () => {
  it.each(["remove hook", "deferred remove hook", "system exit"] as const)(
    "drops every write in a %s without notifications",
    (context) => {
      const world = new World();
      const trigger = world.component(Trigger);
      const onAdd = vi.fn();
      const onSet = vi.fn();
      const update = vi.fn();
      for (const Class of [Present, Missing]) {
        world.component(Class).on("add", onAdd).on("set", onSet);
        world.system(`watch ${Class.name}`).update(Class, update);
      }
      const callback = vi.fn();
      const write = vi.fn((entity: Entity) => {
        expect(entity.destroyed).toBe(true);
        const before = entity.get(Present);
        expect(entity.get(Missing)).toBeUndefined();
        expect(() => {
          entity.add(Missing);
          entity.set(Present, { value: 99 });
          entity.remove(Present);
          entity.modified(Present);
          entity.attach(new Missing());

          const ensured = entity.ensure(Present, callback);
          if (before) {
            expect(ensured).toBe(before);
          } else {
            expect(ensured).toEqual(new Present());
          }
          // Callback-less access is allowed on a dying entity in either mode.
          const mutable = entity.ensure(Present);
          if (before) {
            expect(mutable).toBe(before);
          } else {
            expect(mutable).not.toBe(ensured);
          }
          const first = entity.ensure(Missing, callback);
          const second = entity.ensure(Missing);
          expect(first).toEqual(new Missing());
          expect(second).toEqual(new Missing());
          expect(second).not.toBe(first);
          second.value = 42;
          expect(entity.ensure(Missing)).toEqual(new Missing());
        }).not.toThrow();
        expect(entity.get(Present)).toBe(before);
        expect(before?.value).toBe(context === "system exit" ? undefined : 1);
        expect(entity.get(Missing)).toBeUndefined();
      });

      if (context === "system exit") {
        world.system("teardown").with(Trigger).exit(write);
      } else {
        trigger.on("remove", (entity) => {
          if (context === "deferred remove hook") {
            world.defer(() => write(entity));
          } else {
            write(entity);
          }
        });
      }
      const entity = world.entity().add(Trigger).set(Present, { value: 1 });
      world.progress(0, 0);
      onAdd.mockClear();
      onSet.mockClear();
      update.mockClear();

      expect(() => {
        entity.destroy();
        world.progress(1, 1);
        world.progress(2, 1);
      }).not.toThrow();
      expect(write).toHaveBeenCalledExactlyOnceWith(entity);
      expect(callback).not.toHaveBeenCalled();
      expect(onAdd).not.toHaveBeenCalled();
      expect(onSet).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(entity.get(Present)).toBeUndefined();
      expect(entity.get(Missing)).toBeUndefined();
    }
  );

  it.each([false, true])(
    "drops class, numeric and entity-ref ensures (deferred: %s)",
    (deferred) => {
      const world = new World();
      const component = world.component(Present);
      const entity = world.entity().add(Present);
      const original = entity.get(Present);
      const callback = vi.fn();
      component.on("remove", () => {
        const check = () => {
          expect(entity.ensure(component.eid)).toBe(original);
          expect(entity.ensure(component.eid, callback)).toBe(original);
          expect(entity.ensure(component)).toBe(original);
          expect(entity.ensure(component, callback)).toBe(original);
        };
        if (deferred) {
          world.defer(check);
        } else {
          check();
        }
      });
      entity.destroy();
      const checkMissing = () => {
        const instances = [
          entity.ensure(Present),
          entity.ensure(Present, callback),
          entity.ensure(component.eid),
          entity.ensure(component.eid, callback),
          entity.ensure(component),
          entity.ensure(component, callback),
        ];
        expect(new Set(instances).size).toBe(6);
        for (const instance of instances) {
          expect(instance).toEqual(new Present());
        }
        expect(entity.get(Present)).toBeUndefined();
      };
      if (deferred) {
        world.defer(checkMissing);
      } else {
        checkMissing();
      }
      expect(callback).not.toHaveBeenCalled();
      expect(entity.get(Present)).toBeUndefined();
    }
  );

  it("drops ensure before live-entity relationship and interface validation", () => {
    const world = new World();
    world.component(LinkedTo);
    world.component(Alias);
    world.component(Present).set(Implements, { interfaces: [Alias] });
    const entity = world.entity();
    const callback = vi.fn();
    expect(() => entity.ensure(LinkedTo, callback)).toThrow("Relationship");
    expect(() => entity.ensure(Alias, callback)).toThrow("interface");
    entity.destroy();
    expect(entity.ensure(LinkedTo)).toEqual(new LinkedTo());
    expect(entity.ensure(LinkedTo, callback)).toEqual(new LinkedTo());
    expect(entity.ensure(Alias)).toEqual(new Alias());
    expect(entity.ensure(Alias, callback)).toEqual(new Alias());
    expect(callback).not.toHaveBeenCalled();
    expect(entity.get(LinkedTo)).toBeUndefined();
    expect(entity.get(Alias)).toBeUndefined();
  });
});
