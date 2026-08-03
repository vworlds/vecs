import { describe, expect, it, vi } from "vitest";
import {
  type BeforeSetHandler,
  DontInherit,
  Exclusive,
  Implements,
  Inherit,
  InheritanceModule,
  IsA,
  OneOf,
  OnInstantiate,
  Override,
  Relationship,
  World,
} from "../../src/index.js";

class DefaultValue {
  public nested = { value: 0 };
  public value = 0;
}

class ExplicitValue {
  public nested = { value: 0 };
  public value = 0;
}

class SharedValue {
  public value = 0;
}

class SkippedValue {}
class ExistingValue {
  public value = 0;
}
class LateValue {
  public value = 0;
}
class LateSharedValue {
  public value = 0;
}
class ModeA {}
class ModeB {}
class AliasValue {
  public value = 0;
}
class ConcreteValue extends AliasValue {}
class FirstValue {}
class SecondValue {}
class DataRelationship extends Relationship {
  public value = 0;
}
describe("InheritanceModule", () => {
  it("loads automatically and configures the public component entities", () => {
    const world = new World();
    const onInstantiate = world.component(OnInstantiate);

    expect(world.module(InheritanceModule)).toBe(world.entity(InheritanceModule));
    expect(world.component(IsA).has(Exclusive)).toBe(true);
    expect(onInstantiate.has(Exclusive)).toBe(true);
    expect(onInstantiate.hasTarget(OneOf, onInstantiate)).toBe(true);
    expect(world.component(Override).parent).toBe(onInstantiate);
    expect(world.component(Inherit).parent).toBe(onInstantiate);
    expect(world.component(DontInherit).parent).toBe(onInstantiate);
  });

  it("materializes default and explicit Override copies, Inherit identity, and skips values", () => {
    const world = new World();
    world.component(DefaultValue);
    world.component(ExplicitValue).add(OnInstantiate, Override);
    world.component(SharedValue).add(OnInstantiate, Inherit);
    world.component(SkippedValue).add(OnInstantiate, DontInherit);
    world.component(ExistingValue);
    const template = world
      .entity()
      .set(DefaultValue, { value: 1, nested: { value: 2 } })
      .set(ExplicitValue, { value: 3, nested: { value: 4 } })
      .set(SharedValue, { value: 4 })
      .add(SkippedValue)
      .set(ExistingValue, { value: 5 });
    const child = world.entity().set(ExistingValue, { value: 99 }).add(IsA, template);

    expect(child.get(DefaultValue)).toEqual(template.get(DefaultValue));
    expect(child.get(DefaultValue)).not.toBe(template.get(DefaultValue));
    expect(child.get(DefaultValue)!.nested).toBe(template.get(DefaultValue)!.nested);
    expect(child.get(ExplicitValue)).toEqual(template.get(ExplicitValue));
    expect(child.get(ExplicitValue)).not.toBe(template.get(ExplicitValue));
    expect(child.get(ExplicitValue)!.nested).toBe(template.get(ExplicitValue)!.nested);
    expect(child.get(SharedValue)).toBe(template.get(SharedValue));
    expect(child.has(SkippedValue)).toBe(false);
    expect(child.get(ExistingValue)!.value).toBe(99);
  });

  it("is top-down transitive but does not backfill leaf-first or propagate late additions", () => {
    const world = new World();
    world.component(DefaultValue);
    world.component(SharedValue).add(OnInstantiate, Inherit);
    world.component(LateValue);
    world.component(LateSharedValue).add(OnInstantiate, Inherit);
    const root = world.entity().set(DefaultValue, { value: 1 }).set(SharedValue, { value: 2 });
    const middle = world.entity().add(IsA, root);
    const leaf = world.entity().add(IsA, middle);

    expect(leaf.get(DefaultValue)).toEqual(root.get(DefaultValue));
    expect(leaf.get(DefaultValue)).not.toBe(middle.get(DefaultValue));
    expect(leaf.get(SharedValue)).toBe(root.get(SharedValue));

    const earlyLeaf = world.entity();
    const lateMiddle = world.entity();
    earlyLeaf.add(IsA, lateMiddle);
    lateMiddle.add(IsA, root);
    expect(earlyLeaf.has(DefaultValue)).toBe(false);
    expect(earlyLeaf.has(SharedValue)).toBe(false);

    root.set(LateValue, { value: 3 });
    root.set(LateSharedValue, { value: 3 });
    root.set(DefaultValue, { value: 4 });
    expect(middle.has(LateValue)).toBe(false);
    expect(middle.has(LateSharedValue)).toBe(false);
    expect(middle.get(DefaultValue)!.value).toBe(1);
  });

  it("uses normal hooks, carriers, aliases, exclusivity, and structural query routing", () => {
    const world = new World();
    const add = vi.fn();
    const set = vi.fn();
    const aliasAdd = vi.fn();
    world.component(DefaultValue).on("add", add).on("set", set);
    world.component(AliasValue).on("add", aliasAdd);
    world.component(ConcreteValue).set(Implements, { interfaces: [AliasValue] });
    world.component(ConcreteValue).add(OnInstantiate, Inherit);
    world.component(ModeA);
    world.component(ModeB);
    world.setExclusiveComponents(ModeA, ModeB);
    const query = world.query("inherited-values").with(DefaultValue, ConcreteValue).build();
    const template = world
      .entity()
      .set(DefaultValue, { value: 1 })
      .set(ConcreteValue, { value: 2 });
    const child = world.entity().add(ModeB);
    add.mockClear();
    set.mockClear();
    aliasAdd.mockClear();

    template.add(ModeA);
    child.add(IsA, template);

    expect(add).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledOnce();
    expect(aliasAdd).toHaveBeenCalledOnce();
    expect(world.component(DefaultValue).instanceCount()).toBe(2);
    expect(world.component(ConcreteValue).instanceCount()).toBe(2);
    expect(world.component(AliasValue).instanceCount()).toBe(2);
    expect(child.get(ConcreteValue)).toBe(child.get(AliasValue));
    expect(child.has(ModeA)).toBe(true);
    expect(child.has(ModeB)).toBe(false);
    expect(query.has(child)).toBe(true);
  });

  it("copy-on-write repoints matching descendants and leaves parent and siblings shared", () => {
    const world = new World();
    world.component(SharedValue).add(OnInstantiate, Inherit);
    const root = world.entity().set(SharedValue, { value: 1 });
    const child = world.entity().add(IsA, root);
    const sibling = world.entity().add(IsA, root);
    const descendant = world.entity().add(IsA, child);
    const shadow = world.entity().add(IsA, child);
    const shadowValue = new SharedValue();
    shadowValue.value = 20;
    shadow.attach(shadowValue);

    child.set(SharedValue, { value: 2 });
    const clone = child.get(SharedValue)!;

    expect(clone).not.toBe(root.get(SharedValue));
    expect(descendant.get(SharedValue)).toBe(clone);
    expect(shadow.get(SharedValue)).toBe(shadowValue);
    expect(sibling.get(SharedValue)).toBe(root.get(SharedValue));
    expect(root.get(SharedValue)!.value).toBe(1);

    child.set(SharedValue, { value: 3 });
    expect(child.get(SharedValue)).toBe(clone);
    root.set(SharedValue, { value: 4 });
    expect(sibling.get(SharedValue)!.value).toBe(4);
    expect(child.get(SharedValue)!.value).toBe(3);
  });

  it("exposes reducer-style beforeSet validation and replacement in registration order", () => {
    const world = new World();
    const component = world.component(DefaultValue);
    const calls: string[] = [];
    const replacement1 = new DefaultValue();
    const replacement2 = new DefaultValue();
    let original: Readonly<DefaultValue>;
    const validate: BeforeSetHandler<DefaultValue> = (_entity, current, props) => {
      calls.push(`validate:${current.value}`);
      if ((props.value ?? 0) < 0) {
        throw new Error("negative value");
      }
      return undefined;
    };
    component.on("beforeSet", validate);
    component.on("beforeSet", (_entity, current) => {
      expect(entity.get(DefaultValue)).toBe(original);
      calls.push(`first:${current.value}`);
      return replacement1;
    });
    component.on("beforeSet", (_entity, current) => {
      expect(entity.get(DefaultValue)).toBe(original);
      calls.push(`second:${current === replacement1}`);
      return replacement2;
    });
    const onSet = vi.fn();
    component.on("set", onSet);
    const entity = world.entity().set(DefaultValue, { value: 1 });
    original = entity.get(DefaultValue)!;
    onSet.mockClear();

    entity.set(DefaultValue, { value: 2 });

    expect(calls).toEqual(["validate:1", "first:1", "second:true"]);
    expect(entity.get(DefaultValue)).toBe(replacement2);
    expect(entity.get(DefaultValue)!.value).toBe(2);
    expect(onSet).toHaveBeenCalledOnce();
    expect(() => entity.set(DefaultValue, { value: -1 })).toThrow("negative value");
    expect(entity.get(DefaultValue)!.value).toBe(2);
  });

  it("runs concrete then alias beforeSet reducers against one candidate", () => {
    const world = new World();
    const concrete = world.component(ConcreteValue);
    const alias = world.component(AliasValue);
    concrete.set(Implements, { interfaces: [AliasValue] });
    const first = new ConcreteValue();
    const final = new ConcreteValue();
    const order: string[] = [];
    const entity = world.entity().set(ConcreteValue, { value: 1 });
    const original = entity.get(ConcreteValue)!;
    concrete.on("beforeSet", (_entity, current) => {
      order.push(`concrete:${current === original}`);
      return first;
    });
    alias.on("beforeSet", (_entity, current, props) => {
      order.push(`alias:${current === first}`);
      if ((props.value ?? 0) < 0) {
        throw new Error("alias validation");
      }
      return final;
    });

    entity.set(ConcreteValue, { value: 2 });

    expect(order).toEqual(["concrete:true", "alias:true"]);
    expect(entity.get(ConcreteValue)).toBe(final);
    expect(entity.get(AliasValue)).toBe(final);
    expect(final.value).toBe(2);

    order.length = 0;
    expect(() => entity.set(ConcreteValue, { value: -1 })).toThrow("alias validation");
    expect(entity.get(ConcreteValue)).toBe(final);
    expect(entity.get(AliasValue)).toBe(final);
    expect(final.value).toBe(2);
  });

  it("sets an explicit-class attached plain object when reducers retain it", () => {
    const world = new World();
    const beforeSet = vi.fn(() => undefined);
    world.component(DefaultValue).on("beforeSet", beforeSet);
    const plain = { nested: { value: 1 }, value: 1 };
    const entity = world.entity().attach(DefaultValue, plain);

    entity.set(DefaultValue, { value: 2 });

    expect(beforeSet).toHaveBeenCalledWith(entity, plain, { value: 2 });
    expect(entity.get(DefaultValue)).toBe(plain);
    expect(plain.value).toBe(2);
  });

  it.each(["attach", "remove"] as const)(
    "aborts an outer set after a beforeSet handler performs a reentrant %s",
    (operation) => {
      const world = new World();
      const component = world.component(DefaultValue);
      const entity = world.entity().set(DefaultValue, { value: 1 });
      const replacement = new DefaultValue();
      replacement.value = 7;
      const onSet = vi.fn();
      const afterReentrantSet = vi.fn();
      component.on("set", onSet);
      component.on("beforeSet", (currentEntity) => {
        if (operation === "attach") {
          currentEntity.attach(replacement);
        } else {
          currentEntity.remove(DefaultValue);
        }
        return new DefaultValue();
      });
      component.on("beforeSet", afterReentrantSet);

      entity.set(DefaultValue, { value: 99 });

      expect(afterReentrantSet).not.toHaveBeenCalled();
      if (operation === "attach") {
        expect(entity.get(DefaultValue)).toBe(replacement);
        expect(entity.get(DefaultValue)!.value).toBe(7);
        expect(onSet).toHaveBeenCalledOnce();
        expect(onSet).toHaveBeenCalledWith(entity, replacement);
      } else {
        expect(entity.has(DefaultValue)).toBe(false);
        expect(onSet).not.toHaveBeenCalled();
      }
    }
  );

  it("rejects an alias replacement that is not an instance of the concrete class", () => {
    const world = new World();
    const alias = world.component(AliasValue);
    const concrete = world.component(ConcreteValue).set(Implements, { interfaces: [AliasValue] });
    concrete.add(OnInstantiate, Inherit);
    const parent = world.entity().set(ConcreteValue, { value: 1 });
    const child = world.entity().add(IsA, parent);
    alias.on("beforeSet", () => new AliasValue());

    expect(() => child.set(ConcreteValue, { value: 2 })).toThrow(
      "beforeSet replacement must be an instance of ConcreteValue"
    );

    expect(child.get(ConcreteValue)).toBe(parent.get(ConcreteValue));
    expect(child.get(AliasValue)).toBe(parent.get(ConcreteValue));
    expect(parent.get(ConcreteValue)!.value).toBe(1);
  });

  it("keeps concrete and Implements alias slots coherent through copy-on-write", () => {
    const world = new World();
    const alias = world.component(AliasValue);
    const concrete = world.component(ConcreteValue).set(Implements, { interfaces: [AliasValue] });
    concrete.add(OnInstantiate, Inherit);
    const concreteCandidate = new ConcreteValue();
    const aliasCandidate = new ConcreteValue();
    const order: string[] = [];
    concrete.on("beforeSet", () => {
      order.push("concrete");
      return concreteCandidate;
    });
    alias.on("beforeSet", (_entity, current) => {
      order.push(`alias:${current === concreteCandidate}`);
      return aliasCandidate;
    });
    const parent = world.entity().set(ConcreteValue, { value: 1 });
    const child = world.entity().add(IsA, parent);

    child.set(ConcreteValue, { value: 2 });

    expect(order).toEqual(["concrete", "alias:true"]);
    expect(child.get(ConcreteValue)).toBe(aliasCandidate);
    expect(child.get(ConcreteValue)).toBe(child.get(AliasValue));
    expect(child.get(ConcreteValue)).not.toBe(parent.get(ConcreteValue));
    expect(parent.get(ConcreteValue)).toBe(parent.get(AliasValue));
    expect(parent.get(ConcreteValue)!.value).toBe(1);
  });

  it("leaves attach, remove, and getMut unrestricted without repairing sharing", () => {
    const world = new World();
    const onRemove = vi.fn();
    world.component(SharedValue).add(OnInstantiate, Inherit).on("remove", onRemove);
    const parent = world.entity().set(SharedValue, { value: 1 });
    const removed = world.entity().add(IsA, parent);
    const detached = world.entity().add(IsA, parent);
    const directMutation = world.entity().add(IsA, parent);
    const replacement = new SharedValue();
    replacement.value = 10;

    removed.remove(SharedValue);
    expect(onRemove).toHaveBeenCalledWith(removed, parent.get(SharedValue));

    detached.attach(replacement);
    detached.remove(SharedValue);
    expect(detached.has(SharedValue)).toBe(false);

    directMutation.getMut(SharedValue, (value) => {
      value.value = 5;
    });
    expect(parent.get(SharedValue)!.value).toBe(5);
    expect(directMutation.get(SharedValue)).toBe(parent.get(SharedValue));
  });

  it("allows idempotent policy adds and rejects removal or changes before mutation", () => {
    const world = new World();
    const component = world.component(SharedValue).add(OnInstantiate, Inherit);
    const inherit = world.component(Inherit);

    expect(() => component.add(OnInstantiate, Inherit)).not.toThrow();
    expect(component.target(OnInstantiate)).toBe(inherit);
    expect(() => component.add(OnInstantiate, Override)).toThrow(
      "OnInstantiate policy cannot be removed or changed once set"
    );
    expect(component.target(OnInstantiate)).toBe(inherit);
    expect(() => component.remove(OnInstantiate)).toThrow(
      "OnInstantiate policy cannot be removed or changed once set"
    );
    expect(component.target(OnInstantiate)).toBe(inherit);
  });

  it("keeps IsA add idempotent and rejects removal, retargeting, and cycles before mutation", () => {
    const world = new World();
    const root = world.entity();
    const other = world.entity();
    const child = world.entity().add(IsA, root);

    expect(() => child.add(IsA, root)).not.toThrow();
    expect(() => child.remove(IsA)).toThrow("cannot be removed or retargeted");
    expect(child.target(IsA)).toBe(root);
    expect(() => child.add(IsA, other)).toThrow("cannot be removed or retargeted");
    expect(child.target(IsA)).toBe(root);
    expect(() => root.add(IsA, child)).toThrow("cycle");
    expect(root.has(IsA)).toBe(false);
  });

  it("does not copy Identity or replace a named template's lookup", () => {
    const world = new World();
    world.component(DefaultValue);
    const template = world.entity("named-template").set(DefaultValue, { value: 1 });
    const child = world.entity().add(IsA, template);

    expect(child.name).toBeUndefined();
    expect(world.getEntity("named-template")).toBe(template);
  });

  it("cascades target destruction through inheritors and supports clearAllEntities", () => {
    const world = new World();
    const root = world.entity();
    const child = world.entity().add(IsA, root);
    const leaf = world.entity().add(IsA, child);

    root.destroy();

    expect(child.destroyed).toBe(true);
    expect(leaf.destroyed).toBe(true);

    const anotherWorld = new World();
    anotherWorld.entity().add(IsA, anotherWorld.entity());
    expect(() => anotherWorld.clearAllEntities()).not.toThrow();
    expect(anotherWorld.entities.size).toBe(0);
  });

  it("uses the normal deferred FIFO order for materialization and copy-on-write", () => {
    const world = new World();
    world.component(DefaultValue);
    world.component(SharedValue).add(OnInstantiate, Inherit);
    const template = world.entity().set(DefaultValue, { value: 1 }).set(SharedValue, { value: 1 });
    const child = world.entity();

    world.defer(() => {
      child.add(IsA, template);
      child.set(DefaultValue, { value: 2 });
    });
    expect(child.get(DefaultValue)!.value).toBe(1);

    const descendant = world.entity().add(IsA, child);
    world.defer(() => {
      child.set(SharedValue, { value: 3 });
    });
    expect(child.get(SharedValue)!.value).toBe(3);
    expect(child.get(SharedValue)).not.toBe(template.get(SharedValue));
    expect(descendant.get(SharedValue)).toBe(child.get(SharedValue));
  });

  it("lets deferred materialization commands observe earlier queued component changes", () => {
    const world = new World();
    world.component(DefaultValue);
    world.component(SharedValue).add(OnInstantiate, Inherit);
    const template = world.entity().set(DefaultValue, { value: 1 }).set(SharedValue, { value: 1 });
    const child = world.entity();
    const attachedChild = world.entity();
    const explicit = new SharedValue();
    explicit.value = 5;

    world.defer(() => {
      child.add(IsA, template);
      template.set(DefaultValue, { value: 9 });
      attachedChild.add(IsA, template);
      attachedChild.attach(explicit);
    });

    expect(child.get(DefaultValue)!.value).toBe(9);
    expect(attachedChild.get(SharedValue)).toBe(template.get(SharedValue));
  });

  it.each(["source", "template"] as const)(
    "stops immediate materialization when an ordinary hook destroys the %s",
    (destroyedEntity) => {
      const world = new World();
      world.component(FirstValue).on("add", (entity) => {
        if (entity.target(IsA)) {
          (destroyedEntity === "source" ? entity : entity.target(IsA)!).destroy();
        }
      });
      world.component(SecondValue);
      const template = world.entity().add(FirstValue).add(SecondValue);
      const child = world.entity();

      child.add(IsA, template);

      expect(child.destroyed).toBe(true);
      expect(child.get(SecondValue)).toBeUndefined();
    }
  );

  it("does not run beforeSet for relationship property updates", () => {
    const world = new World();
    const beforeSet = vi.fn();
    world.component(DataRelationship).on("beforeSet", beforeSet);
    const source = world.entity().add(DataRelationship, world.entity());

    source.set(DataRelationship, { value: 2 });

    expect(source.get(DataRelationship)!.value).toBe(2);
    expect(beforeSet).not.toHaveBeenCalled();
  });
});
