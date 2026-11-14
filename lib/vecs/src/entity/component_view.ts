import type { ComponentInstance } from "../component_meta.js";
import type { ReadonlyIterableArrayMap } from "../util/array_map.js";
import type { Entity } from "./entity.js";

/** Lazy read-only component view. Only ids are snapshotted; instances stay live. @internal */
export class ComponentView implements ReadonlyIterableArrayMap<ComponentInstance> {
  public constructor(private readonly _entity: Entity) {}

  public get size(): number {
    return this._entity._ceids.length;
  }

  public [Symbol.iterator](): IterableIterator<readonly [number, ComponentInstance]> {
    return this.entries();
  }

  public entries(): IterableIterator<readonly [number, ComponentInstance]> {
    return this._entries(this._entity._ceids.slice());
  }

  public forEach(
    callback: (
      value: ComponentInstance,
      key: number,
      map: ReadonlyIterableArrayMap<ComponentInstance>
    ) => void
  ): void {
    for (const [key, value] of this.entries()) {
      callback(value, key, this);
    }
  }

  public forEachSafe(
    callback: (
      value: ComponentInstance,
      key: number,
      map: ReadonlyIterableArrayMap<ComponentInstance>
    ) => void
  ): void {
    this.forEach(callback);
  }

  public get(key: number): ComponentInstance | undefined {
    return this._entity._get(key);
  }

  public has(key: number): boolean {
    return this.get(key) !== undefined;
  }

  public values(): ComponentInstance[] {
    return [...this.entries()].map((entry) => entry[1]);
  }

  private *_entries(
    ids: readonly number[]
  ): IterableIterator<readonly [number, ComponentInstance]> {
    for (const id of ids) {
      const value = this.get(id);
      if (value !== undefined) {
        yield [id, value];
      }
    }
  }
}
