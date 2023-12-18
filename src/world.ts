import { ComponentSnapshot, StateDiff } from "@vworlds/protocol";
import { Component } from "./component.js";
import { Entity } from "./entity.js";
import { EntityTestFunc, PARENT, System, SystemBase } from "./system.js";
import { ArrayMap } from "../../util/array_map.js";
import { Parent } from "./parent.js";
import { BitPtr } from "../../util/bitset.js";
import { TagModule } from "./tags.js";

const PARENT_TYPE = 31;

export class World {
  private entities = new Map<number, Entity>(); // maps entity Id to Entity
  private archChangeQueue: Entity[] = [];
  private entitiesWithoutParent: Entity[] = [];
  private systems = new ArrayMap<SystemBase>();
  private componentClasses = new ArrayMap<typeof Component>();
  private updatedComponents: Component[] = [];
  public readonly tags: TagModule;
  constructor() {
    this.register(Parent, PARENT_TYPE);
    this.tags = new TagModule(this);
  }

  private getOrCreateEntity(eid: number) {
    let e = this.entities.get(eid);
    if (!e) {
      e = new Entity(this, eid);
      this.entities.set(eid, e);
    }
    return e;
  }

  public _getComponentInstance(type: number) {
    const ComponentClass = this.componentClasses.get(type);
    if (!ComponentClass) {
      throw "unregistered component type";
    }
    return new ComponentClass();
  }

  public archetypeChanged(e: Entity) {
    if (e._archetypeChanged) return;
    e._archetypeChanged = true;
    this.archChangeQueue.push(e);
    e.children.forEach((child) => this.archetypeChanged(child));
  }

  public _notifyComponentAdded(e: Entity, c: Component) {
    if (c.type == PARENT_TYPE && e.parent === undefined)
      this.entitiesWithoutParent.push(e);

    this.archetypeChanged(e);
  }

  public _notifyComponentRemoved(e: Entity, c: Component) {
    if (e.empty()) this.entities.delete(e.eid);
    this.archetypeChanged(e);
  }

  private updateNetworkComponent(snapshot: ComponentSnapshot) {
    const e = this.getOrCreateEntity(snapshot.eid);
    const c = e.add(snapshot.type, false);
    c.updateFromSnapshot(snapshot);
    return c;
  }

  private removeNetworkComponent(cid: number) {
    const type = cid & 0xff;
    const eid = cid >> 8;
    this.entities.get(eid)?.remove(type);
  }

  private updateArchetypes() {
    this.entitiesWithoutParent.forEach((e) => {
      const parent = e.get(Parent);
      if (parent) {
        const parentEntity = this.entities.get(parent.pid);
        if (parentEntity) {
          e.parent = parentEntity;
          parentEntity.children.add(e);
        } else console.error("Parent entity not found");
      }
    });
    this.entitiesWithoutParent.length = 0;
    if (this.archChangeQueue.length > 0) {
      this.systems.forEach((s) => {
        this.archChangeQueue.forEach((e) => {
          if (s.belongs(e)) {
            e._addSystem(s);
          } else {
            e._removeSystem(s);
          }
        });
      });
      this.archChangeQueue.forEach((e) => {
        e.clearDeleted();
        if (e.empty()) {
          e.destroy();
        }
      });
    }
    this.updatedComponents.forEach((c) => {
      c.entity._notifyModified(c);
      c["dirty"] = false;
    });
    this.archChangeQueue.forEach((e) => {
      e._updateSystems();
      e._archetypeChanged = false;
    });
    this.archChangeQueue.length = 0;
    this.updatedComponents.length = 0;
  }

  public _queueUpdatedComponent(c: Component) {
    if (c["dirty"]) return;
    c["dirty"] = true;
    this.updatedComponents.push(c);
  }

  public register(ComponentClass: typeof Component, type: number) {
    const C = this.componentClasses.get(type);
    if (C) {
      throw `Component ${type} already registered`;
    }
    ComponentClass.type = type;
    ComponentClass.bitPtr = new BitPtr(ComponentClass.type);
    this.componentClasses.set(ComponentClass.type, ComponentClass);
  }

  public addSystem(s: SystemBase) {
    this.systems.set(s.id, s);
  }

  public getSystem(key: number): SystemBase | undefined {
    return this.systems.get(key);
  }

  public system<S extends (typeof Component)[]>(
    name: string,
    componentWatchlist: readonly [...S],
    entityTestFunc?: EntityTestFunc
  ) {
    const system = new System(name, componentWatchlist, entityTestFunc);
    this.addSystem(system);
    return system;
  }

  public update(diff: StateDiff) {
    if (!diff.from) {
      // this is a full snapshot. Destroy everything.
      this.entities.forEach((e) => {
        e.destroy();
      });
      this.entities.clear();
    }

    diff.snapshots?.forEach((snapshot) => {
      this.updatedComponents.push(this.updateNetworkComponent(snapshot));
    });

    diff.removed?.forEach((id) => {
      this.removeNetworkComponent(id);
    });

    this.updateArchetypes();

    this.systems.forEach((s) => {
      s.run();
      this.updateArchetypes();
    });
  }

  public getEntity(id: number): Entity | undefined {
    return this.entities.get(id);
  }
}
