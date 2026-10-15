import { Entity, DontSnapshot, OnSnapshot, type Component } from "@vworlds/vecs";

/** @internal Serialize a value without traversing foreign class instances. */
export function serialize(value: unknown, depth = 4): unknown {
  if (value instanceof Entity) {
    return { $entity: value.eid };
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "object") {
    return { $opaque: typeof value };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) {
    return { $opaque: proto?.constructor?.name ?? "unknown" };
  }
  if (depth <= 0) {
    return { $opaque: "depth limit" };
  }
  if (Array.isArray(value)) {
    return value.map((v) => serialize(v, depth - 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key, serialize(v, depth - 1)])
  );
}

/** @internal Policy-aware serialization of a component's public data at the root. */
export function componentValue(component: Component, value: object): unknown {
  if (opaqueComponent(component)) {
    return { $opaque: component.meta.Class.name };
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(component.meta.isRelationship && key === "_targets"))
      .map(([key, v]) => [key, serialize(v)])
  );
}

/** @internal Read policy through public relationship accessors, never core internals. */
export function opaqueComponent(component: Component): boolean {
  return component.target(OnSnapshot)?.meta.Class === DontSnapshot;
}
