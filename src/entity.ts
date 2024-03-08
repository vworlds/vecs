import { Component } from "./component.js";
import type { World } from "./world.js";
import { ArrayMap } from "./util/array_map.js";
import { type System } from "./system.js";
import { Events } from "@vworlds/utils";
import { Bitset } from "./util/bitset.js";

type EntityEvents = Events<{ destroy(): void }>;

export class Entity {
  private components = new ArrayMap<Component>(); //maps component types to Components
  private deletedComponents = new ArrayMap<Component>(); //maps deleted component types to Components

  public readonly componentBitmask = new Bitset();
  private readonly systems = new Set<System>();
  private readonly newSystems: System[] = [];
  public properties = new Map<string, any>();
  public declare _events: EntityEvents;
  public parent: Entity | undefined;
  private _children: Set<Entity> | undefined;
  public _archetypeChanged: boolean = false;
  private destroyed = false;

  constructor(public readonly world: World, public readonly eid: number) {}

  public get children(): Set<Entity> {
    if (!this._children) this._children = new Set<Entity>();
    return this._children;
  }

  public add<C extends typeof Component>(
    Class: C,
    markAsModified?: boolean
  ): InstanceType<C>;
  public add(type: number, markAsModified?: boolean): Component;
  public add(
    typeOrClass: number | typeof Component,
    markAsModified: boolean = true
  ) {
    const type = this.world.getComponentType(typeOrClass);

    let c = this.components.get(type);
    if (c) {
      return c;
    }
    c = this.world["getComponentInstance"](typeOrClass, this);

    this.components.set(type, c);
    this.componentBitmask.add(type);
    this.world._notifyComponentAdded(this, c);
    if (markAsModified) this.world._queueUpdatedComponent(c);

    return c;
  }

  public remove<C extends typeof Component>(Class: C): void;
  public remove(type: number): void;
  public remove(typeOrClass: number | typeof Component): void {
    const type = this.world.getComponentType(typeOrClass);
    const c = this.components.get(type);
    if (c) {
      this.components.delete(type);
      this.deletedComponents.set(type, c);
      this.componentBitmask.delete(type);
      this.world._notifyComponentRemoved(this, c);
    }
  }

  public _notifyModified(component: Component) {
    this.systems.forEach((s) => {
      s.notifyModified(component);
    });
  }

  public get<C extends typeof Component>(
    typeOrClass: number | C,
    get_deleted: boolean = false
  ): InstanceType<C> | undefined {
    const type = this.world.getComponentType(typeOrClass);

    const c = this.components.get(type);
    if (!c && get_deleted) {
      return this.deletedComponents.get(type) as InstanceType<C> | undefined;
    }
    return c as InstanceType<C> | undefined;
  }

  public get events(): EntityEvents {
    if (!this._events) {
      this._events = new Events();
    }
    return this._events;
  }

  public _hasSystem(s: System) {
    return this.systems.has(s);
  }

  public _addSystem(s: System) {
    if (!this.systems.has(s)) {
      this.newSystems.push(s);
      s.enter(this);
    }
  }

  public _removeSystem(s: System) {
    if (this.systems.delete(s)) {
      s.exit(this);
    }
  }

  public _updateSystems() {
    this.newSystems.forEach((s) => {
      this.systems.add(s);
    });
    this.newSystems.length = 0;
  }

  public get empty() {
    return this.components.size == 0;
  }

  private _destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.systems.forEach((s) => {
      s.exit(this);
    });
    this.systems.clear();

    if (this._events) {
      this._events.emit("destroy");
      this._events.removeAllListeners("destroy");
    }
  }

  public destroy() {
    this.world._notifyEntityDestroyed(this);
    this.children.forEach((child) => {
      child.destroy();
    });
    this.children.clear();
    if (this.parent) {
      this.parent.children.delete(this);
      this.world.archetypeChanged(this.parent);
      this.parent = undefined;
    }
  }

  public clearDeletedComponents() {
    this.deletedComponents.clear();
  }

  public forEachComponent(callback: (c: Component) => void) {
    this.components.forEach(callback);
  }

  public toString(): string {
    return `Entity${this.eid}`;
  }
}
