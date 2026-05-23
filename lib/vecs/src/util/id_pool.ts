export interface IdPoolConfig {
  name: string;
  min: number;
  max?: number;
}

export class IdPool {
  private readonly _reserved = new Set<number>();

  public constructor(
    public readonly name: string,
    public readonly min: number,
    public readonly max: number | undefined
  ) {}

  public alloc(): number {
    for (let id = this.min; this.max === undefined || id <= this.max; id++) {
      if (!this._reserved.has(id)) {
        this._reserved.add(id);
        return id;
      }
    }
    throw new Error(`Id pool '${this.name}' is exhausted`);
  }

  public free(id: number): void {
    if (!this.owns(id)) {
      throw new Error(`Id ${id} does not belong to pool '${this.name}'`);
    }
    this._reserved.delete(id);
  }

  public owns(id: number): boolean {
    return id >= this.min && (this.max === undefined || id <= this.max);
  }

  public reserve(id: number): void {
    if (!this.owns(id)) {
      throw new Error(`Id ${id} does not belong to pool '${this.name}'`);
    }
    if (this._reserved.has(id)) {
      throw new Error(`Id ${id} is already reserved`);
    }
    this._reserved.add(id);
  }
}

export function validateIdPoolConfigs(configs: readonly IdPoolConfig[]): void {
  if (configs.length === 0) {
    throw new Error("At least one id pool is required");
  }

  const names = new Set<string>();
  let openEndedCount = 0;
  let expectedMin = 1;

  configs.forEach((config, index) => {
    if (names.has(config.name)) {
      throw new Error(`Duplicate id pool name '${config.name}'`);
    }
    names.add(config.name);

    if (!Number.isSafeInteger(config.min) || config.min <= 0) {
      throw new Error(`Id pool '${config.name}' must start at a positive integer`);
    }
    if (config.min !== expectedMin) {
      throw new Error(`Id pools must cover 1..Infinity without holes`);
    }

    if (config.max === undefined) {
      openEndedCount++;
      if (index !== configs.length - 1) {
        throw new Error("Only the final id pool may be open-ended");
      }
      return;
    }

    if (!Number.isSafeInteger(config.max) || config.max <= 0) {
      throw new Error(`Id pool '${config.name}' max must be a positive integer`);
    }
    if (config.max < config.min) {
      throw new Error(`Id pool '${config.name}' max must be >= min`);
    }
    expectedMin = config.max + 1;
  });

  if (openEndedCount !== 1) {
    throw new Error("Exactly one id pool must be open-ended");
  }
  if (!names.has("component") || !names.has("entity")) {
    throw new Error("Id pools must include 'component' and 'entity'");
  }
}
