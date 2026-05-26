import { Component, type ComponentClass, type ComponentType } from "../component.js";
import { Entity, type EntityClass } from "../entity/index.js";
import { type IdPool } from "../util/id_pool.js";
import { Entities } from "./world.entities.js";
import { type World } from "./world.js";

const RESERVED_EID = 0;

export class Components extends Entities {
  /** @internal `true` once {@link start} or {@link disableComponentRegistration} has been called. */
  protected _componentRegistrationDisabled = false;

  public component<T extends ComponentType>(
    this: World,
    ComponentClass: T,
    eid?: number
  ): Component<T> {
    return this._component<Component<T>>(Component, ComponentClass, eid);
  }

  /** Prevent any further calls to {@link component}. */
  public disableComponentRegistration(): void {
    this._componentRegistrationDisabled = true;
  }

  public get<C extends ComponentClass>(
    this: World,
    Class: C
  ): Readonly<InstanceType<C>> | undefined {
    return this.component(Class).get(Class);
  }

  public set<C extends ComponentClass>(
    this: World,
    Class: C,
    props: Partial<InstanceType<C>>
  ): Component<C> {
    return this.component(Class).set(Class, props);
  }

  /** Declare a group of mutually exclusive components. */
  public setExclusiveComponents(this: World, ...components: ComponentClass[]): void {
    const metas = components.map((C) => this.entity(C).ownMeta);
    for (let i = 0; i < metas.length; i++) {
      metas[i]._exclusive = metas.filter((_, j) => j !== i);
    }
  }

  /** @internal Register a component-like entity in the requested id pool. */
  protected _component<T extends Entity>(
    this: World,
    Constructor: EntityClass<T>,
    ComponentClass: ComponentType,
    eid?: number,
    pool: IdPool = this._componentPool
  ): T {
    if (eid === RESERVED_EID) {
      throw new Error(`Component eid ${eid} is reserved`);
    }

    const existingComponent = this._classRegistry.get(ComponentClass) as T | undefined;
    if (existingComponent) {
      if (eid === undefined || eid === existingComponent.eid) {
        return existingComponent;
      }
      throw new Error(
        `Component class ${ComponentClass.name} is already registered with eid ${existingComponent.eid}`
      );
    }
    if (this._componentRegistrationDisabled) {
      throw "World component registration is disabled";
    }
    if (eid === undefined) {
      eid = pool.alloc();
    } else {
      if (this._entities.has(eid)) {
        throw new Error(`Entity id ${eid} is already taken`);
      }
      this._reserveEid(eid);
    }
    const component = new Constructor(this, eid, ComponentClass);
    this._entities.set(eid, component);
    this._placeNewEntity(component);
    this._classRegistry.set(ComponentClass, component);
    return component;
  }
}
