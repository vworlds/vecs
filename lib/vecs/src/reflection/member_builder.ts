import type { Component, ComponentType } from "../component.js";
import { DontSnapshot } from "../modules/snapshot_types.js";
import { type MemberType, type RangeBound } from "./member_types.js";
import {
  _declareMembers,
  _structDefinition,
  VecsStruct,
  type MemberDeclaration,
} from "./vecs_struct.js";

/**
 * Fluent declaration of one component member, returned by
 * {@link Component.member}. Each call merges into the class's process-wide
 * {@link VecsStruct} definition and throws when it contradicts it.
 *
 * ```ts
 * world.component(Position)
 *   .member("x", "i32").range(-100, 100).unit("m")
 *   .member("y", "i32").range(-100, 100);
 * ```
 */
export class ComponentMember<T extends ComponentType = ComponentType> {
  /** @internal */
  public constructor(
    private readonly _component: Component<T>,
    /** The member being declared. */
    public readonly name: string
  ) {}

  /** Declare this member's human-readable description. */
  public description(text: string): this {
    return this._declare({ description: text });
  }

  /**
   * Declare the next member. Same as {@link Component.member} on the
   * component this chain started from.
   */
  public member<K extends keyof InstanceType<T> & string>(
    name: K,
    type: MemberType
  ): ComponentMember<T> {
    return this._component.member(name, type);
  }

  /** Declare this numeric member's inclusive `[min, max]` range. Metadata only. */
  public range(min: RangeBound, max: RangeBound): this {
    return this._declare({ range: [min, max] });
  }

  /** Declare this member's unit of measure, for example `"m"`. */
  public unit(text: string): this {
    return this._declare({ unit: text });
  }

  /** Declare the allowed values of this `enum` member. */
  public values(allowed: readonly number[]): this {
    return this._declare({ values: allowed });
  }

  private _declare(declaration: MemberDeclaration): this {
    _declareComponentMember(this._component, this.name, declaration);
    return this;
  }
}

/** @internal Merge one declaration and keep this world's `VecsStruct` in step. */
export function _declareComponentMember(
  component: Component,
  name: string,
  declaration: MemberDeclaration
): void {
  const changed = _declareMembers(component.meta.Class, [[name, declaration]]);
  if (!component.has(_vecsStructComponent(component))) {
    _attachVecsStruct(component);
  } else if (changed) {
    component.modified(VecsStruct);
  }
}

/** @internal Attach the class's definition to its component entity, if it has one. */
export function _attachVecsStruct(component: Component): void {
  const definition = _structDefinition(component.meta.Class);
  if (definition !== undefined) {
    _vecsStructComponent(component);
    component.attach(VecsStruct, definition.instance);
  }
}

function _vecsStructComponent(component: Component): Component {
  const world = component.world;
  const registered = world.getEntity(VecsStruct) as Component | undefined;
  if (registered !== undefined) {
    return registered;
  }
  // Definitions are local schema metadata, like `ComponentDef`. Registering
  // lazily keeps the component ids of worlds that declare no members unchanged.
  return world.component(VecsStruct).snapshotPolicy(DontSnapshot);
}
