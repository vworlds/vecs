import { ComponentSnapshot } from "@vworlds/protocol";
import { BitPtr, Bitset } from "../../util/bitset.js";
import type { Entity } from "./entity.js";
import { Type } from "../components/types.js";

export class Component {
  public entity!: Entity;
  public static type: Type = 255;
  public static bitPtr: BitPtr;

  public updateFromSnapshot(state: ComponentSnapshot) {}

  public get type(): number {
    const ComponentClass = this.constructor as typeof Component;
    return ComponentClass.type;
  }

  public modified() {
    this.entity.world._queueUpdatedComponent(this);
  }
}

export type ComponentClassArray = (typeof Component)[];

export function calculateComponentBitmask(classes: ComponentClassArray) {
  const bitmask = new Bitset();
  classes.forEach((C) => {
    bitmask.add(C.type);
  });
  return bitmask;
}
