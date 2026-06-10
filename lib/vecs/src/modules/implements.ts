import { Implements, type ComponentMeta } from "../component_meta.js";
import { type Entity } from "../entity/index.js";
import { Module } from "../module.js";

export { Implements } from "../component_meta.js";

/** Built-in world module that maintains abstract/interface component aliases. */
export class ImplementsModule extends Module {
  private readonly _declaring = new Set<Entity>();
  private _touched = new Set<ComponentMeta>();

  public init(): void {
    const component = this.world.component(Implements);

    component.onSet((entity) => {
      this._declaring.add(entity);
      this._recompute();
    });

    component.onRemove((entity) => {
      this._declaring.delete(entity);
      this._recompute();
    });
  }

  private _closureOf(
    meta: ComponentMeta,
    direct: Map<ComponentMeta, ComponentMeta[]>,
    path: ComponentMeta[],
    out: ComponentMeta[]
  ): void {
    for (const ifaceMeta of direct.get(meta) ?? []) {
      const cycleStart = path.indexOf(ifaceMeta);
      if (cycleStart !== -1) {
        const cycle = [...path.slice(cycleStart), ifaceMeta]
          .map((cycleMeta) => cycleMeta.Class.name)
          .join(" -> ");
        throw new Error(`Cyclic Implements declaration: ${cycle}`);
      }

      if (!out.includes(ifaceMeta)) {
        out.push(ifaceMeta);
      }
      this._closureOf(ifaceMeta, direct, [...path, ifaceMeta], out);
    }
  }

  private _recompute(): void {
    this._resetPrevious();

    const direct = new Map<ComponentMeta, ComponentMeta[]>();
    const touched = new Set<ComponentMeta>();

    for (const entity of this._declaring) {
      const meta = entity.meta;
      const implementsComponent = entity.get(Implements)!;
      const interfaces = implementsComponent.interfaces.map(
        (InterfaceClass) => this.world.entity(InterfaceClass).meta
      );

      this._validateDeclaration(meta, interfaces);
      direct.set(meta, interfaces);
      touched.add(meta);
      interfaces.forEach((ifaceMeta) => touched.add(ifaceMeta));
    }

    for (const [meta] of direct) {
      const closure: ComponentMeta[] = [];
      this._closureOf(meta, direct, [meta], closure);
      meta._implementsClosure = closure;
      closure.forEach((ifaceMeta) => {
        ifaceMeta._isInterface = true;
        touched.add(ifaceMeta);
      });
    }

    this._touched = touched;
  }

  private _resetPrevious(): void {
    for (const meta of this._touched) {
      meta._implementsClosure = undefined;
      meta._isInterface = false;
    }
    this._touched.clear();
  }

  private _validateDeclaration(meta: ComponentMeta, interfaces: ComponentMeta[]): void {
    if (meta.isRelationship) {
      throw new Error(`Relationship ${meta.Class.name} cannot implement interfaces`);
    }

    for (const ifaceMeta of interfaces) {
      if (ifaceMeta.isRelationship) {
        throw new Error(`Relationship ${ifaceMeta.Class.name} cannot be an interface`);
      }
    }
  }
}
