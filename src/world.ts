import { ComponentSnapshot, StateDiff } from "@vworlds/protocol";
import {
  Component,
  ComponentClassOrType,
  ComponentMeta,
  Hook,
} from "./component.js";
import { Entity } from "./entity.js";
import { System } from "./system.js";
import { Parent } from "./parent.js";
import { TagModule } from "./tags.js";
import { sortSystems } from "./sort.js";

const PARENT_TYPE = 31;
const LOCAL_COMPONENT_MIN = 256;

export class World {
  private entities = new Map<number, Entity>(); // maps entity Id to Entity
  private componentNameTypeMap = new Map<string, number>();
  private archChangeQueue: Entity[] = [];
  private entitiesWithoutParent: Entity[] = [];
  private systems: System[] = [];
  private componentClasses = new Map<typeof Component, ComponentMeta>();
  private type2Class = new Map<number, typeof Component>();
  private updatedComponents: Component[] = [];
  private localComponentCounter = LOCAL_COMPONENT_MIN;
  public readonly tags: TagModule;
  private componentRegistrationDisabled = false;
  private systemRegistrationDisabled = false;
  constructor() {
    this.registerComponent(Parent, PARENT_TYPE, "NetworkedParent");
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

  private getComponentInstance(
    typeOrClass: ComponentClassOrType,
    entity: Entity
  ) {
    let ComponentClass: typeof Component;
    if (typeof typeOrClass === "function") {
      ComponentClass = typeOrClass;
    } else {
      const C = this.type2Class.get(typeOrClass);
      if (!C) {
        throw `unregistered component type ${typeOrClass}`;
      }
      ComponentClass = C;
    }
    const meta = this.componentClasses.get(ComponentClass);
    if (!meta) throw `unregistered component meta for ${ComponentClass.name}`;

    const c = new ComponentClass(entity, meta);
    const hook = meta["onAddHandler"];
    if (hook) hook(c);

    return c;
  }

  public getComponentClass(type: number) {
    return this.type2Class.get(type);
  }

  public getComponentMeta(ComponentClass: typeof Component) {
    const meta = this.componentClasses.get(ComponentClass);
    if (!meta)
      throw `Unregistered component ${ComponentClass.constructor.name}`;
    return meta;
  }

  public getComponentType(typeOrClass: ComponentClassOrType) {
    if (typeof typeOrClass === "function") {
      return this.getComponentMeta(typeOrClass).type;
    }
    return typeOrClass;
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
    const hook = c.meta["onRemoveHandler"];
    if (hook) hook(c);

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
    const e = this.entities.get(eid);
    if (!e) return;
    if (type == 255) {
      e.forEachComponent((c) => {
        e.remove(c.type);
      });
    } else {
      e.remove(type);
    }
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
      const hook = c.meta["onSetHandler"];
      if (hook) hook(c);
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

  public registerComponent(ComponentClass: typeof Component): void;
  public registerComponent(
    ComponentClass: typeof Component,
    type: number
  ): void;
  public registerComponent(
    ComponentClass: typeof Component,
    componentName?: string
  ): void;
  public registerComponent(
    ComponentClass: typeof Component,
    type: number,
    componentName: string
  ): void;
  public registerComponent(
    ComponentClass: typeof Component,
    typeOrComponentName?: number | string,
    componentName?: string
  ): void {
    if (this.componentRegistrationDisabled) {
      throw "World component registartion is disabled";
    }
    let type: number | undefined = undefined;

    // Determine if the second argument is type or componentName based on its type
    if (typeof typeOrComponentName === "number") {
      type = typeOrComponentName;
    } else if (typeof typeOrComponentName === "string") {
      componentName = typeOrComponentName;
    }

    componentName = componentName || ComponentClass.name;
    let local = false;
    if (type === undefined) {
      // attempt to get type id from name->type map
      type = this.componentNameTypeMap.get(componentName);
      if (type === undefined) {
        type = this.localComponentCounter++;
        local = true;
      }
    }

    let meta = this.componentClasses.get(ComponentClass);
    if (meta) {
      if (local) this.localComponentCounter--;
      throw `Trying to register ${componentName} with type=${type} which is already registered to ${meta.componentName}`;
    }
    this.registerComponentType(componentName, type);
    meta = new ComponentMeta(type, componentName);
    this.componentClasses.set(ComponentClass, meta);
    this.type2Class.set(type, ComponentClass);
    console.log(
      "Registered component %s with type=%d as %s component",
      componentName,
      type,
      local ? "local" : "networked"
    );
  }

  public registerComponentType(componentName: string, type: number) {
    this.componentNameTypeMap.set(componentName, type);
  }

  public addSystem(s: System) {
    if (this.systemRegistrationDisabled)
      throw "System registration is disabled";
    this.systems.push(s);
  }

  public system(name: string) {
    const system = new System(name, this);
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
      const c = this.updateNetworkComponent(snapshot);
      c.modified();
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

  public disableComponentRegistration() {
    this.componentRegistrationDisabled = true;
  }

  public start() {
    this.componentRegistrationDisabled = true;
    this.systemRegistrationDisabled = true;
    this.reindexSystems();
  }

  public reindexSystems() {
    this.systems = sortSystems(this.systems);
    console.log("Reindexed systems:");
    this.systems.forEach((s) => console.log(s.name));
  }

  public hook<T extends typeof Component>(C: T): Hook<InstanceType<T>> {
    return this.getComponentMeta(C) as any;
  }
}
