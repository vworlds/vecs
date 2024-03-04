import { ComponentSnapshot } from "@vworlds/protocol";
import { BitPtr, Bitset } from "../../util/bitset.js";
import type { Entity } from "./entity.js";
import { type World } from "./world.js";

export class ComponentMeta {
  public readonly type: number;
  public readonly componentName: string;
  public readonly bitPtr: BitPtr;

  constructor(type: number, componentName: string) {
    this.type = type;
    this.componentName = componentName;
    this.bitPtr = new BitPtr(type);
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

  public updateFromSnapshot(state: ComponentSnapshot) {}

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
