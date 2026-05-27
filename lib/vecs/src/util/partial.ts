export type Constructor<T = object> = new (...args: any[]) => T;

const INITIALIZERS = Symbol("partial.initializers");

type Initializer = (self: object) => void;

type PartialBaseConstructor = Constructor & {
  [INITIALIZERS]?: Initializer[];
};

type PartialFeatureConstructor = Constructor;

function getOrCreateInitializers(Base: PartialBaseConstructor): Initializer[] {
  if (!Object.prototype.hasOwnProperty.call(Base, INITIALIZERS)) {
    Object.defineProperty(Base, INITIALIZERS, {
      value: [],
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }

  return Base[INITIALIZERS]!;
}

export abstract class PartialClass {
  protected initializePartials(): void {
    const ctor = this.constructor as PartialBaseConstructor;
    const initializers = ctor[INITIALIZERS] ?? [];

    for (const initialize of initializers) {
      initialize(this);
    }
  }

  static addMixin<TBase extends PartialBaseConstructor, TPartial extends PartialFeatureConstructor>(
    Base: TBase,
    PartialClass: TPartial
  ): void {
    const initializers = getOrCreateInitializers(Base);

    for (const key of Reflect.ownKeys(PartialClass.prototype)) {
      if (key === "constructor") {
        continue;
      }

      const descriptor = Object.getOwnPropertyDescriptor(PartialClass.prototype, key);

      if (!descriptor) {
        continue;
      }

      if (key === "initialize") {
        if (typeof descriptor.value !== "function") {
          throw new Error(`${PartialClass.name}.initialize must be a method if present`);
        }

        const initialize = descriptor.value;

        initializers.push((self: object) => {
          initialize.call(self);
        });

        continue;
      }

      if (Object.prototype.hasOwnProperty.call(Base.prototype, key)) {
        throw new Error(
          `Cannot apply ${PartialClass.name}: ${String(key)} already exists on ${Base.name}`
        );
      }

      Object.defineProperty(Base.prototype, key, descriptor);
    }
  }
}
