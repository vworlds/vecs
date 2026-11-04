import type { Entity } from "../entity/index.js";
import { DontSnapshot } from "../modules/snapshot_types.js";
import {
  _declareMembers,
  _structInstance,
  VecsStruct,
  type MemberDeclaration,
} from "./vecs_struct.js";

/**
 * @internal Merge one declaration and keep this world's `VecsStruct` in step,
 * on this class and on any registered subclass that inherits the member.
 */
export function _declareComponentMember(
  component: Entity,
  name: string,
  declaration: MemberDeclaration
): void {
  const Class = component.meta.Class;
  const changed = _declareMembers(Class, [[name, declaration]]);
  const vecsStruct = _vecsStructComponent(component);
  for (const registered of component.world._classRegistry.values()) {
    const RegisteredClass = registered.meta.Class;
    if (RegisteredClass !== Class && !(RegisteredClass.prototype instanceof Class)) {
      continue;
    }
    if (!registered.has(vecsStruct)) {
      _attachVecsStruct(registered);
    } else if (changed) {
      registered.modified(VecsStruct);
    }
  }
}

/** @internal Attach the class's definition to its component entity, if it has one. */
export function _attachVecsStruct(component: Entity): void {
  const instance = _structInstance(component.meta.Class);
  if (instance !== undefined) {
    _vecsStructComponent(component);
    component.attach(VecsStruct, instance);
  }
}

function _vecsStructComponent(component: Entity): Entity {
  const world = component.world;
  const registered = world.getEntity(VecsStruct);
  if (registered !== undefined) {
    return registered;
  }
  // Definitions are local schema metadata, like `ComponentDef`. Registering
  // lazily keeps the component ids of worlds that declare no members unchanged.
  return world.component(VecsStruct).snapshotPolicy(DontSnapshot);
}
