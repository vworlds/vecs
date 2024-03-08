import {
  Component,
  ComponentClassOrType,
  ComponentMeta,
  Hook,
} from "./component.js";
import { Entity } from "./entity.js";
import { System } from "./system.js";
import { sortSystems } from "./sort.js";
import { ArrayMap } from "./util/array_map.js";
import { IPhase, Phase } from "./phase.js";

const LOCAL_COMPONENT_MIN = 256;

export class World {
  private entities = new Map<number, Entity>(); // maps entity Id to Entity
  private componentNameTypeMap = new Map<string, number>();
  private archChangeQueue: Entity[] = [];
  private destroyedEntities: Entity[] = [];
  private pendingSystems: System[] = [];
  private allSystems: System[] = [];

  private Class2Meta = new Map<typeof Component, ComponentMeta>();
  private Type2Meta = new ArrayMap<ComponentMeta>();
  private updatedComponents: Component[] = [];
  private localComponentCounter = LOCAL_COMPONENT_MIN;
  private componentRegistrationDisabled = false;
  private systemRegistrationDisabled = false;
  private pipeline = new Map<string, Phase>();
  private eidCounter = 0;
  constructor() {}

  public getOrCreateEntity(
    eid: number,
    onCreateCallback?: (e: Entity) => void
  ) {
    let e = this.entities.get(eid);
    if (!e) {
      e = new Entity(this, eid);
      this.entities.set(eid, e);
      if (onCreateCallback) onCreateCallback(e);
    }
    return e;
  }

  public entity(id: number): Entity | undefined {
    return this.entities.get(id);
  }

  public createEntity(): Entity {
    const eid = this.eidCounter++;
    const e = new Entity(this, eid);
    this.entities.set(eid, e);
    return e;
  }

  public setEntityIdRange(min: number) {
    if (this.componentRegistrationDisabled)
      throw "setEntityIdRange must be called before registering components";
    this.eidCounter = min;
  }

  private getComponentInstance(
    typeOrClass: ComponentClassOrType,
    entity: Entity
  ) {
    const meta = this.getComponentMeta(typeOrClass);
    const c = new meta.Class(entity, meta);
    const hook = meta["onAddHandler"];
    if (hook) hook(c);

    return c;
  }

  public getComponentMeta(typeOrClass: ComponentClassOrType) {
    let meta: ComponentMeta | undefined;
    if (typeof typeOrClass === "function") {
      meta = this.Class2Meta.get(typeOrClass);
    } else {
      meta = this.Type2Meta.get(typeOrClass);
    }
    if (!meta)
      throw `unregistered component meta for component type or class '${typeOrClass}'`;
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
    this.archetypeChanged(e);
  }

  public _notifyComponentRemoved(e: Entity, c: Component) {
    const hook = c.meta["onRemoveHandler"];
    if (hook) hook(c);

    this.archetypeChanged(e);
  }

  public _notifyEntityDestroyed(e: Entity) {
    if (!this.entities.delete(e.eid)) return;
    e.forEachComponent((c) => {
      e.remove(c.type);
    });
    this.destroyedEntities.push(e);
  }

  private updateArchetypes() {
    if (this.archChangeQueue.length > 0) {
      this.allSystems.forEach((s) => {
        this.archChangeQueue.forEach((e) => {
          if (s.belongs(e)) {
            e._addSystem(s);
          } else {
            e._removeSystem(s);
          }
        });
      });
      this.archChangeQueue.forEach((e) => {
        e.clearDeletedComponents();
      });
    }

    this.destroyedEntities.forEach((e) => {
      e["_destroy"]();
    });
    this.destroyedEntities.length = 0;

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

    let meta = this.Class2Meta.get(ComponentClass);
    if (meta) {
      if (local) this.localComponentCounter--;
      throw `Trying to register ${componentName} with type=${type} which is already registered to ${meta.componentName}`;
    }
    this.registerComponentType(componentName, type);
    meta = new ComponentMeta(ComponentClass, type, componentName);
    this.Class2Meta.set(ComponentClass, meta);
    this.Type2Meta.set(type, meta);
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
    this.pendingSystems.push(s);
  }

  public system(name: string) {
    const system = new System(name, this);
    this.addSystem(system);
    return system;
  }

  public disableComponentRegistration() {
    this.componentRegistrationDisabled = true;
  }

  public start() {
    this.componentRegistrationDisabled = true;
    this.systemRegistrationDisabled = true;
    this.reindexSystems();
  }

  private reindexSystems() {
    let _defaultPhase = this.pipeline.get("update");
    if (!_defaultPhase) {
      _defaultPhase = new Phase("update", this);
      this.pipeline.set(_defaultPhase.name, _defaultPhase);
    }

    const defaultPhase = _defaultPhase;

    this.pendingSystems.forEach((s) => {
      let phase = s._phase as Phase | undefined;
      if (typeof phase === "string") {
        phase = this.pipeline.get(phase);
      }
      phase = phase || defaultPhase;
      phase.systems.push(s);
    });
    this.pendingSystems.length = 0;

    this.allSystems.length = 0;
    this.pipeline.forEach((phase) => {
      phase.systems = sortSystems(phase.systems);
      this.allSystems.push(...phase.systems);
      console.log(
        "Phase %s : %s",
        phase.name,
        phase.systems.map((s) => s.name).join(" -> ")
      );
    });
  }

  public hook<T extends typeof Component>(C: T): Hook<InstanceType<T>> {
    return this.getComponentMeta(C) as any;
  }

  public addPhase(name: string): IPhase {
    const phase = new Phase(name, this);
    this.pipeline.set(name, phase);
    return phase;
  }

  public runPhase(phase: IPhase, now: number, delta: number) {
    (phase as Phase).systems.forEach((s) => {
      s.run(now, delta);
      this.updateArchetypes();
    });
  }

  public clearAllEntities() {
    this.entities.forEach((e) => {
      e.destroy();
    });
    this.entities.clear();
  }
}
