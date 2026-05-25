import { Entity } from "./entity/index.js";

export {
  ComponentMeta,
  type ComponentClass,
  type ComponentInstance,
  type ComponentRef,
  type ComponentRefArray,
  type Hook,
} from "./component_meta.js";

/** A component entity created by {@link World.component}. */
export class Component extends Entity {}
