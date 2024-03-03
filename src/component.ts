import { ComponentSnapshot } from "@vworlds/protocol";
import { BitPtr, Bitset } from "../../util/bitset.js";
import type { Entity } from "./entity.js";

export class Component {
  public entity!: Entity;
  public static _type: number;
  public static componentName: string = "anonymous";
  public static _bitPtr: BitPtr;
  private dirty: boolean = false;

  public updateFromSnapshot(state: ComponentSnapshot) {}

  public get type(): number {
    const ComponentClass = this.constructor as typeof Component;
    return ComponentClass.type;
  }

  public static get type() {
    return this._type;
  }

  public static set type(t: number) {
    if (t === this._type) return;
    if (this._type !== undefined)
      throw `Component type was already set to ${this._type}`;
    this._bitPtr = new BitPtr(t);
    this._type = t;
  }

  public static get bitPtr(): BitPtr {
    return this._bitPtr;
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
