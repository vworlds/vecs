import {
  Component,
  ComponentDef,
  Module,
  DependsOn,
  Entity,
  ChildOf,
  Identity,
  type World,
  type QueryDSL,
} from "@vworlds/vecs";
import { componentSchema } from "../schema/index.js";
import { componentValue } from "./serialize.js";
import { mutate } from "./mutate.js";
import { WatchSet } from "./watch.js";

/** @internal Local-world command executor, shared by transports. */
export class LocalWorld {
  /** Live, session-owned watches; inert until explicitly created. */
  public readonly watches: WatchSet;

  public constructor(
    public readonly world: World,
    private readonly readOnly = false
  ) {
    this.watches = new WatchSet(world);
  }

  /** Execute a world tool; watch tools require the bridge-injected session owner. */
  public command(command: string, params: Record<string, unknown>): unknown {
    switch (command) {
      case "vecs_watch":
        return this.watches.create(params, this.registry());
      case "vecs_events":
        return this.watches.read(params);
      case "vecs_unwatch":
        return this.watches.remove(params);
      case "vecs_components":
        return this._components(params.filter as string | undefined);
      case "vecs_find":
        return this._find(params);
      case "vecs_entity":
        return this._entity(params.entity);
      case "vecs_mutate":
        return mutate(this.world, this.registry(), params.ops, this.readOnly);
      case "vecs_systems":
        return this._systems(params);
      case "vecs_stats": {
        // Refresh pending pipeline definitions so newly configured systems are listed before a tick.
        void this.world.pipeline;
        return {
          systems: this.world.stats
            .systems()
            .map(({ system, ...timing }) => ({ name: system.name, ...timing })),
          operations: this.world.stats.operations(),
        };
      }
      default:
        throw new Error(`Unknown command ${command}`);
    }
  }

  public counts(): { entities: number; components: number; systems: number } {
    return {
      entities: this.world.entities.size,
      components: this.registry().size,
      systems: this.world.pipeline.length,
    };
  }

  public registry(): Map<string, Component> {
    const components = [...this.world.entities.values()].filter(
      (entity): entity is Component => entity instanceof Component
    );
    const counts = new Map<string, number>();
    for (const c of components) {
      counts.set(c.meta.Class.name, (counts.get(c.meta.Class.name) ?? 0) + 1);
    }
    return new Map(
      components.map((c) => [
        counts.get(c.meta.Class.name) === 1 ? c.meta.Class.name : `${c.meta.Class.name}@${c.eid}`,
        c,
      ])
    );
  }

  private _components(filter?: string): unknown[] {
    const registry = this.registry();
    const names = new Map([...registry].map(([name, c]) => [c.eid, name]));
    const componentDefEid = this.world.getEntity(ComponentDef)?.eid;
    const provenance = new Set([
      this.world.getEntity(ChildOf)?.eid,
      this.world.getEntity(Identity)?.eid,
    ]);
    return [...registry]
      .filter(([name]) => filter === undefined || name.includes(filter))
      .map(([name, component]) => {
        const { schema, description } = componentSchema(component.meta.Class);
        let parent = component.parent;
        const visited = new Set<number>();
        while (parent && !(parent instanceof Module) && !visited.has(parent.eid)) {
          visited.add(parent.eid);
          parent = parent.parent;
        }
        const trait =
          !provenance.has(component.eid) && [...registry.values()].some((c) => c.has(component));
        return {
          name,
          eid: component.eid,
          kind:
            component instanceof Module
              ? "module"
              : component.meta.isRelationship
                ? "relationship"
                : trait
                  ? "trait"
                  : "component",
          ...(parent instanceof Module ? { module: parent.meta.Class.name } : {}),
          carriers: component.instanceCount(),
          traits: [...component.components.entries()]
            .filter(([eid]) => !provenance.has(eid) && eid !== componentDefEid)
            .map(([eid]) => names.get(eid) ?? String(eid)),
          schema,
          ...(description === undefined ? {} : { description }),
        };
      });
  }

  private _entity(ref: unknown): unknown {
    const entity = resolveEntity(this.world, ref);
    const registry = this.registry();
    const relationships = Object.fromEntries(
      [...registry]
        .filter(([, c]) => c.meta.isRelationship && (entity.has(c) || entity.children(c).size > 0))
        .map(([name, c]) => [
          name,
          {
            targets: entity.targets(c).map((e) => e.eid),
            children: [...entity.children(c)].map((e) => e.eid),
          },
        ])
    );
    return {
      eid: entity.eid,
      name: entity.name,
      parent: entity.parent?.eid ?? null,
      components: this._values(entity, registry),
      relationships,
    };
  }

  private _find(params: Record<string, unknown>): unknown {
    const registry = this.registry();
    const include = params.include === undefined ? [] : params.include;
    if (
      !Array.isArray(include) ||
      include.some((name) => typeof name !== "string" || !registry.has(name))
    ) {
      throw new Error("include must contain registered component names");
    }
    const selected = new Map((include as string[]).map((name) => [name, registry.get(name)!]));
    const limit = params.limit ?? 50;
    const offset = params.offset ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      (limit as number) < 0 ||
      !Number.isSafeInteger(offset) ||
      (offset as number) < 0
    ) {
      throw new Error("limit and offset must be non-negative integers");
    }
    const entities: unknown[] = [];
    let total = 0;
    this.world.filter(query(params.where, registry)).forEach((entity) => {
      if (total >= (offset as number) && entities.length < (limit as number)) {
        entities.push({
          eid: entity.eid,
          name: entity.name,
          components: this._values(entity, selected),
        });
      }
      total++;
    });
    return { total, entities };
  }

  private _systems(params: Record<string, unknown>): unknown {
    // Force the public pipeline rebuild before reading timings for newly configured systems.
    void this.world.pipeline;
    if (params.enable !== undefined || params.disable !== undefined) {
      if (this.readOnly) {
        throw new Error("readOnly server: enable and disable are forbidden");
      }
      if (this.world.deferred) {
        throw new Error("Cannot change systems while world.deferred is true");
      }
      const changes = (["enable", "disable"] as const).flatMap((action) => {
        if (params[action] === undefined) {
          return [];
        }
        const system = this.world.pipeline.find((s) => s.name === params[action]);
        if (!system) {
          throw new Error(`Unknown system ${params[action]}`);
        }
        return [{ action, system }];
      });
      for (const { action, system } of changes) {
        system[action]();
      }
    }
    return this.world.stats.systems().map(({ system, ...timing }) => ({
      name: system.name,
      phase: system.entity.target(DependsOn)?.name ?? null,
      enabled: system.enabled,
      callbacks: system.callbacks,
      watched: system.watched.map((C) => C.name),
      timing,
    }));
  }

  private _values(entity: Entity, registry: Map<string, Component>): Record<string, unknown> {
    return Object.fromEntries(
      [...registry]
        .filter(([, c]) => entity.has(c))
        .map(([name, c]) => [name, componentValue(c, entity.get(c)!)])
    );
  }
}

/** @internal Resolve an existing entity without creating it on a miss. */
export function resolveEntity(world: World, ref: unknown): Entity {
  if (
    (typeof ref !== "number" || !Number.isSafeInteger(ref) || ref <= 0) &&
    typeof ref !== "string"
  ) {
    throw new Error("entity must be a positive eid or Identity name");
  }
  const entity = world.getEntity(ref as number | string);
  if (!entity || entity.destroyed) {
    throw new Error(`Unknown entity ${ref}`);
  }
  return entity;
}

/** @internal Translate JSON queries; watch mode rejects filter-only operators at any depth. */
export function query(value: unknown, registry: Map<string, Component>, watch = false): QueryDSL {
  const component = (name: unknown): Component => {
    if (typeof name !== "string" || !registry.has(name)) {
      throw new Error(`Unknown component ${String(name)}`);
    }
    return registry.get(name)!;
  };
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return component(value);
  }
  if (Array.isArray(value)) {
    return { all: value.map((v) => query(v, registry, watch)) };
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("where must be a query DSL expression");
  }
  const entries = Object.entries(value);
  if ("test" in value) {
    throw new Error("test predicates are not supported by vecs_find");
  }
  if (entries.length !== 1) {
    throw new Error("A query expression must have exactly one operator");
  }
  const [operator, term] = entries[0];
  if (watch && (operator === "source" || operator === "children")) {
    throw new Error(`${operator} is filter-only: vecs_find supports it, vecs_watch does not`);
  }
  switch (operator) {
    case "all":
    case "any":
      if (!Array.isArray(term)) {
        throw new Error(`${operator} requires an array`);
      }
      return operator === "all"
        ? { all: term.map((v) => query(v, registry, watch)) }
        : { any: term.map((v) => query(v, registry, watch)) };
    case "not":
    case "parent":
    case "children":
      return { [operator]: query(term, registry, watch) } as QueryDSL;
    case "only":
      return { only: Array.isArray(term) ? term.map(component) : component(term) };
    case "target":
    case "source": {
      if (!Array.isArray(term) || term.length !== 2) {
        throw new Error(`${operator} requires [relationship, query]`);
      }
      const rel = component(term[0]);
      if (!rel.meta.isRelationship) {
        throw new Error(`${term[0]} is not a relationship`);
      }
      return operator === "target"
        ? { target: [rel, query(term[1], registry, watch)] }
        : { source: [rel, query(term[1], registry, watch)] };
    }
    default:
      throw new Error(`Unknown query operator ${operator}`);
  }
}
