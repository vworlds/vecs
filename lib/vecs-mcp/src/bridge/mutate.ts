import { Entity, type Component, type World } from "@vworlds/vecs";
import { componentSchema, validateSet, type FieldSpec } from "../schema/index.js";
import { opaqueComponent } from "./serialize.js";
import { resolveEntity } from "./world.js";

type Op = Record<string, unknown>;
type ShadowKey = Entity | string;
type Shadow = {
  key: ShadowKey;
  name?: string;
  live: boolean;
  values: Map<Component, Record<string, unknown>>;
};
const actions = ["create", "destroy", "name", "add", "set", "remove", "link", "unlink"];

/**
 * @internal Validate the complete batch before synchronously applying its ops between ticks.
 * `nameOf` indexes the same live definitions as `registry`, for O(k) shadow reads.
 */
export function mutate(
  world: World,
  registry: Map<string, Component>,
  input: unknown,
  readOnly: boolean,
  nameOf: ReadonlyMap<number, string>
): unknown {
  if (readOnly) {
    throw new Error("readOnly server: vecs_mutate is forbidden");
  }
  if (world.deferred) {
    throw new Error("vecs_mutate requires world.deferred to be false; call between ticks");
  }
  if (!Array.isArray(input)) {
    throw new Error("ops must be an array");
  }
  const ops = input.map(parseOp);
  preflight(world, registry, ops, nameOf);
  const created: Entity[] = [];
  const applied: unknown[] = [];
  for (let index = 0; index < ops.length; index++) {
    try {
      applied.push(apply(world, registry, ops[index], created));
    } catch (error) {
      return {
        applied,
        error: { index, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }
  return { applied };
}

function parseOp(value: unknown): Op {
  if (!plain(value)) {
    throw new Error("Each op must be an object");
  }
  const action = actions.filter((key) => key in value && !(key === "name" && "create" in value));
  if (action.length !== 1 || value[action[0]] !== true) {
    throw new Error("Each op must have exactly one action set to true");
  }
  const allowed =
    action[0] === "create"
      ? ["create", "name"]
      : action[0] === "name"
        ? ["name", "entity", "value"]
        : action[0] === "link" || action[0] === "unlink"
          ? [action[0], "entity", "relationship", "to"]
          : [
              action[0],
              "entity",
              ...(action[0] === "destroy" ? [] : ["component"]),
              ...(action[0] === "set" ? ["value"] : []),
            ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error(`Unexpected parameter in ${action[0]} op`);
  }
  if (action[0] === "create" && value.name !== undefined && typeof value.name !== "string") {
    throw new Error("create.name must be a string");
  }
  if (action[0] === "name" && typeof value.value !== "string") {
    throw new Error("name.value must be a string");
  }
  return value;
}

function preflight(
  world: World,
  registry: Map<string, Component>,
  ops: Op[],
  nameOf: ReadonlyMap<number, string>
): void {
  const shadows = new Map<ShadowKey, Shadow>();
  const creates = new Set<string>();
  // Only batch changes live here; null masks a name removed by a preceding rename.
  const names = new Map<string, ShadowKey | null>();
  const named = (name: string): ShadowKey | undefined =>
    names.has(name) ? (names.get(name) ?? undefined) : world.getEntity(name);
  const ref = (value: unknown): Shadow => {
    let key: Entity | string;
    if (typeof value === "string" && /^\$\d+$/.test(value)) {
      if (!creates.has(value)) {
        throw new Error(`Unknown create reference ${value}`);
      }
      key = value;
    } else if (typeof value === "string") {
      const existing = named(value);
      if (!existing) {
        throw new Error(`Unknown entity ${value}`);
      }
      key = existing;
    } else {
      key = resolveEntity(world, value);
    }
    let shadow = shadows.get(key);
    if (!shadow) {
      shadow = {
        key,
        name: key instanceof Entity ? key.name : undefined,
        live: true,
        values: new Map(),
      };
      if (key instanceof Entity) {
        for (const [eid, current] of key.components.entries()) {
          const name = nameOf.get(eid);
          const c = name === undefined ? undefined : registry.get(name);
          if (c) {
            shadow.values.set(c, { ...current });
          }
        }
      }
      shadows.set(key, shadow);
    }
    if (!shadow.live) {
      throw new Error(`Entity ${String(value)} was destroyed by an earlier op`);
    }
    return shadow;
  };
  for (const [index, op] of ops.entries()) {
    try {
      if (op.create) {
        const key = `$${creates.size}`;
        creates.add(key);
        shadows.set(key, {
          key,
          name: op.name as string | undefined,
          live: true,
          values: new Map(),
        });
        if (typeof op.name === "string" && op.name) {
          names.set(op.name, key);
        }
        continue;
      }
      const shadow = ref(op.entity);
      if (op.destroy) {
        shadow.live = false;
        continue;
      }
      if (op.name) {
        if (shadow.name && named(shadow.name) === shadow.key) {
          names.set(shadow.name, null);
        }
        shadow.name = op.value as string;
        if (shadow.name) {
          names.set(shadow.name, shadow.key);
        }
        continue;
      }
      const c = getComponent(registry, op.component ?? op.relationship);
      if (op.link || op.unlink) {
        if (!c.meta.isRelationship) {
          throw new Error(`${op.relationship} is not a relationship`);
        }
        ref(op.to);
      }
      if (op.set || op.add || op.remove || op.link || op.unlink) {
        if (opaqueComponent(c)) {
          throw new Error(`${c.meta.Class.name} is opaque (DontSnapshot), never writable`);
        }
      }
      if (op.set) {
        if (!plain(op.value)) {
          throw new Error("set.value must be a plain object patch");
        }
        const patch = entityPatch(world, componentSchema(c.meta.Class).fields, op.value);
        const current = shadow.values.get(c) ?? { ...instantiate(c) };
        checkWritable(current, op.value);
        const draft = { ...current, ...patch };
        validateSet(world, c.meta.Class, draft, op.value);
        shadow.values.set(c, draft);
      } else if (op.add && !shadow.values.has(c)) {
        shadow.values.set(c, { ...instantiate(c) });
      } else if (op.remove) {
        shadow.values.delete(c);
      }
    } catch (error) {
      throw new Error(`ops[${index}]: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function apply(world: World, registry: Map<string, Component>, op: Op, created: Entity[]): unknown {
  const ref = (value: unknown): Entity => {
    if (typeof value === "string" && /^\$\d+$/.test(value)) {
      const entity = created[Number(value.slice(1))];
      if (!entity || entity.destroyed) {
        throw new Error(`Unknown create reference ${value}`);
      }
      return entity;
    }
    return resolveEntity(world, value);
  };
  if (op.create) {
    const entity = world.entity();
    if (typeof op.name === "string") {
      entity.name = op.name;
    }
    created.push(entity);
    return { eid: entity.eid };
  }
  const entity = ref(op.entity);
  if (op.destroy) {
    entity.destroy();
  } else if (op.name) {
    entity.name = op.value as string;
  } else {
    const c = getComponent(registry, op.component ?? op.relationship);
    if (op.add) {
      entity.add(c);
    } else if (op.remove) {
      entity.remove(c);
    } else if (op.link) {
      entity.add(c, ref(op.to));
    } else if (op.unlink) {
      entity.remove(c, ref(op.to));
    } else if (op.set) {
      const current = entity.get(c) ?? instantiate(c);
      const patch = entityPatch(
        world,
        componentSchema(c.meta.Class).fields,
        op.value as Record<string, unknown>
      );
      const draft = { ...current, ...patch };
      checkWritable(current as Record<string, unknown>, op.value as Record<string, unknown>);
      validateSet(world, c.meta.Class, draft, op.value as Record<string, unknown>);
      entity.set(c, patch);
    }
  }
  return { eid: entity.eid };
}

function getComponent(registry: Map<string, Component>, name: unknown): Component {
  const c = typeof name === "string" ? registry.get(name) : undefined;
  if (!c) {
    throw new Error(`Unknown component ${String(name)}`);
  }
  return c;
}

function instantiate(c: Component): object {
  return new (c.meta.Class as new () => object)();
}

function checkWritable(current: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, next] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`${key} is not writable`);
    }
    checkOpaque(current[key], key, new Set());
    if (plain(next)) {
      checkWritable({}, next);
    }
    if (Array.isArray(next)) {
      next.forEach((item) => {
        if (plain(item)) {
          checkWritable({}, item);
        }
      });
    }
  }
}

function checkOpaque(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`${path} is opaque, never writable`);
  }
  if (typeof value !== "object" || value === null || value instanceof Entity) {
    return;
  }
  if ((!Array.isArray(value) && !plain(value)) || seen.has(value)) {
    throw new Error(`${path} is opaque, never writable`);
  }
  seen.add(value);
  for (const [key, v] of Object.entries(value)) {
    checkOpaque(v, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function entityPatch(
  world: World,
  fields: Readonly<Record<string, FieldSpec>>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).map(([key, value]) => {
      const spec = fields[key];
      if (spec?.type === "entity" && typeof value === "number") {
        return [key, resolveEntity(world, value)];
      }
      if (spec?.fields && plain(value)) {
        return [key, entityPatch(world, spec.fields, value)];
      }
      if (spec?.items && Array.isArray(value)) {
        return [key, value.map((item) => entityPatch(world, { item: spec.items! }, { item }).item)];
      }
      return [key, value];
    })
  );
}

function plain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
