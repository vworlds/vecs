// Deep copy for the default `ClonePublic` policy.
//
// The default policy has to promise something stronger than "the fields are
// there": a destination entity is a *live* copy that keeps running after the
// source is gone, and a shallow field copy would leave both copies aliasing one
// nested object. So the default copies plain data all the way down — arrays,
// plain objects, `Map`, `Set`, typed arrays, `Date` — and refuses anything whose
// detachment it cannot vouch for. Refusing loudly at capture is the point: an
// un-copyable value is the owning module's business, not something to guess at.
//
// A component type that mixes plain data with something exotic declares
// `CustomSnapshot` and owns its own detachment.

import { type ComponentType } from "../component_meta.js";
import { type SnapshotMaterialize } from "../modules/snapshot_types.js";

/**
 * @internal Copy one captured component's own fields, deeply.
 *
 * @param data - The source instance's own enumerable fields.
 * @param owner - Component class name, used in the thrown message.
 * @returns A detached copy that shares no object, array, or collection with
 *   `data`. Cycles and shared references are preserved as such.
 * @throws If a nested value is not plain data — anything whose prototype is
 *   neither `Object.prototype` nor `null`, and not one of the copied built-ins.
 */
export function _cloneSnapshotData(
  data: Record<string, unknown>,
  owner: string
): Record<string, unknown> {
  const seen = new Map<object, unknown>();
  const clone: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    clone[key] = _clone(value, `${owner}.${key}`, owner, seen);
  }
  return clone;
}

/** @internal The default materializer: `new Class()` plus field assignment. */
export function _clonePublicMaterialize(Class: ComponentType): SnapshotMaterialize {
  const Ctor = Class as new () => object;
  return (data) => Object.assign(new Ctor(), (data ?? {}) as object);
}

/** @internal Deep-copy one value, or throw naming the path that holds it. */
function _clone(value: unknown, path: string, owner: string, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw _unclonable(path, owner, value);
    }
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }

  if (value instanceof Date) {
    const copy = new Date(value.getTime());
    seen.set(value, copy);
    return copy;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (let i = 0; i < value.length; i++) {
      copy.push(_clone(value[i], `${path}[${i}]`, owner, seen));
    }
    return copy;
  }

  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, entry] of value) {
      copy.set(
        _clone(key, `${path} key`, owner, seen),
        _clone(entry, `${path} entry`, owner, seen)
      );
    }
    return copy;
  }

  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const entry of value) {
      copy.add(_clone(entry, `${path} entry`, owner, seen));
    }
    return copy;
  }

  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0);
    seen.set(value, copy);
    return copy;
  }

  if (ArrayBuffer.isView(value)) {
    // `DataView` has no copy-from-view constructor, so slice its buffer instead.
    const copy =
      value instanceof DataView
        ? new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
        : new (value.constructor as new (source: ArrayBufferView) => ArrayBufferView)(value);
    seen.set(value, copy);
    return copy;
  }

  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const copy: Record<string, unknown> = Object.create(prototype);
    seen.set(value, copy);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = _clone(entry, `${path}.${key}`, owner, seen);
    }
    return copy;
  }

  throw _unclonable(path, owner, value);
}

/** @internal Build the "cannot copy this" error for one offending path. */
function _unclonable(path: string, owner: string, value: unknown): Error {
  const name = value instanceof Object ? value.constructor.name : String(value);
  return new Error(
    `snapshotSubtree: ${path} holds a ${name}, which the default ClonePublic policy cannot copy; ` +
      `declare a CustomSnapshot policy on ${owner} to define how it crosses worlds`
  );
}
