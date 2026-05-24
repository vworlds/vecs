export interface IdPoolConfig {
  name: string;
  min: number;
  max?: number;
}

export class IdPool {
  private readonly _reserved = new Set<number>();
  private readonly _freed: number[] = [];
  private _next: number;

  public constructor(
    public readonly name: string,
    public readonly min: number,
    public readonly max: number | undefined
  ) {
    this._next = min;
  }

  public alloc(): number {
    while (this._freed.length > 0) {
      const candidate = this._popMin();
      if (!this._reserved.has(candidate)) {
        this._reserved.add(candidate);
        return candidate;
      }
    }
    while (this.max === undefined || this._next <= this.max) {
      if (!this._reserved.has(this._next)) {
        const id = this._next++;
        this._reserved.add(id);
        return id;
      }
      this._next++;
    }
    throw new Error(`Id pool '${this.name}' is exhausted`);
  }

  public free(id: number): void {
    if (!this.owns(id)) {
      throw new Error(`Id ${id} does not belong to pool '${this.name}'`);
    }
    if (!this._reserved.delete(id)) {
      return;
    }
    if (id < this._next) {
      this._pushFreed(id);
    }
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

  private _popMin(): number {
    const heap = this._freed;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  private _pushFreed(id: number): void {
    const heap = this._freed;
    heap.push(id);
    this._siftUp(heap.length - 1);
  }

  private _siftDown(start: number): void {
    const heap = this._freed;
    const n = heap.length;
    let i = start;
    while (true) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && heap[left] < heap[smallest]) {
        smallest = left;
      }
      if (right < n && heap[right] < heap[smallest]) {
        smallest = right;
      }
      if (smallest === i) {
        return;
      }
      const tmp = heap[i];
      heap[i] = heap[smallest];
      heap[smallest] = tmp;
      i = smallest;
    }
  }

  private _siftUp(start: number): void {
    const heap = this._freed;
    let i = start;
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (heap[parent] <= heap[i]) {
        return;
      }
      const tmp = heap[i];
      heap[i] = heap[parent];
      heap[parent] = tmp;
      i = parent;
    }
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
