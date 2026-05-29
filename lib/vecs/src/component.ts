import { Entity } from "./entity/index.js";
import type { ComponentClass, ComponentInstance, ComponentType } from "./component_meta.js";

export {
  CleanupPolicy,
  ComponentMeta,
  type ComponentClass,
  type ComponentInstance,
  type ComponentRef,
  type ComponentRefArray,
  type ComponentType,
  type Hook,
} from "./component_meta.js";

/** A component entity created by {@link World.component}. */
export class Component<T extends ComponentType = ComponentType> extends Entity {
  public onAdd(handler: (entity: Entity, c: InstanceType<T>) => void): this {
    this.ownMeta.onAdd(handler as (entity: Entity, c: ComponentInstance) => void);
    return this;
  }

  public onRemove(handler: (entity: Entity, c: InstanceType<T>) => void): this {
    this.ownMeta.onRemove(handler as (entity: Entity, c: ComponentInstance) => void);
    return this;
  }

  public onSet(handler: (entity: Entity, c: InstanceType<T>) => void): this {
    this.ownMeta.onSet(handler as (entity: Entity, c: ComponentInstance) => void);
    return this;
  }
}
