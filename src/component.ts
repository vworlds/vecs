import { BitPtr, Bitset } from "./util/bitset.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";

export interface Hook<C extends Component = Component> {
  onAdd(handler: (c: C) => void): Hook<C>;
  onRemove(handler: (c: C) => void): Hook<C>;
  onSet(handler: (c: C) => void): Hook<C>;
}

export class ComponentMeta implements Hook<Component> {
  public readonly Class: typeof Component;
  public readonly type: number;
  public readonly componentName: string;
  public readonly bitPtr: BitPtr;
  private onAddHandler: ((c: Component) => void) | undefined;
  private onRemoveHandler: ((c: Component) => void) | undefined;
  private onSetHandler: ((c: Component) => void) | undefined;

  constructor(Class: typeof Component, type: number, componentName: string) {
    this.Class = Class;
    this.type = type;
    this.componentName = componentName;
    this.bitPtr = new BitPtr(type);
  }

  public onAdd(handler: (c: Component) => void): ComponentMeta {
    this.onAddHandler = handler;
    return this;
  }

  public onRemove(handler: (c: Component) => void): ComponentMeta {
    this.onRemoveHandler = handler;
    return this;
  }

  public onSet(handler: (c: Component) => void): ComponentMeta {
    this.onSetHandler = handler;
    return this;
  }
}

export type ComponentClassOrType = number | typeof Component;

export type ComponentClassArray = ComponentClassOrType[];

export class Component {
  private dirty: boolean = false;

  constructor(
    public readonly entity: Entity,
    public readonly meta: ComponentMeta
  ) {}

  public get type(): number {
    return this.meta.type;
  }

  public get bitPtr(): BitPtr {
    return this.meta.bitPtr;
  }

  public modified() {
    this.entity.world._queueUpdatedComponent(this);
  }

  public toString(): string {
    return this.meta.componentName;
  }
}

export function calculateComponentBitmask(
  classes: ComponentClassArray,
  world: World
) {
  const bitmask = new Bitset();
  classes.forEach((C) => {
    bitmask.add(world.getComponentType(C));
  });
  return bitmask;
}
