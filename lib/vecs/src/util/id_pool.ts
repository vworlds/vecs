export interface IdPoolConfig {
  name: string;
  min: number;
  max?: number;
}

export class IdPool {
  // Occupancy bitmap: bit `(id - min)` is 1 iff `id` is currently reserved.
  // Stored as a growable plain-number array (V8 keeps these as SMIs / packed
  // double-tagged words, which gives the fastest random-access read/write).
  private _bits: number[] = [];
  // Number of reserved ids strictly below `_next`. When zero, alloc can skip
  // the bitmap scan entirely and just hand out the next never-used id.
  private _freeBelowNext = 0;
  // Word cursor: the lowest word index in `_bits` that *might* contain a 0
  // bit below `_next`. Pure hint - alloc walks forward from here. Bumped
  // up when alloc fills a word to all-ones and pulled back down by free.
  private _minFreeWord = 0;
  // The smallest id never yet handed out by alloc (high-water mark). All ids
  // in `[min, _next)` are either reserved (1 in `_bits`) or free (0).
  private _next: number;

  public constructor(
    public readonly name: string,
    public readonly min: number,
    public readonly max: number | undefined
  ) {
    this._next = min;
  }

  public alloc(): number {
    if (this._freeBelowNext > 0) {
      const bits = this._bits;
      let word = this._minFreeWord;
      while (bits[word] === -1) {
        word++;
      }
      const w = bits[word];
      const bit = ctz32(~w);
      const nw = w | (1 << bit);
      bits[word] = nw;
      // Advance the cursor past words we've just filled so the next alloc
      // doesn't re-walk them.
      this._minFreeWord = nw === -1 ? word + 1 : word;
      this._freeBelowNext--;
      return this.min + word * 32 + bit;
    }
    const max = this.max;
    let id = this._next;
    while (max === undefined || id <= max) {
      const offset = id - this.min;
      const word = offset >>> 5;
      const mask = 1 << offset;
      this._growBits(word + 1);
      const cur = this._bits[word];
      if ((cur & mask) === 0) {
        this._bits[word] = cur | mask;
        this._next = id + 1;
        return id;
      }
      id++;
    }
    throw new Error(`Id pool '${this.name}' is exhausted`);
  }

  public free(id: number): void {
    if (!this.owns(id)) {
      throw new Error(`Id ${id} does not belong to pool '${this.name}'`);
    }
    const offset = id - this.min;
    const word = offset >>> 5;
    if (word >= this._bits.length) {
      return;
    }
    const mask = 1 << offset;
    const cur = this._bits[word];
    if ((cur & mask) === 0) {
      return;
    }
    this._bits[word] = cur & ~mask;
    if (id < this._next) {
      this._freeBelowNext++;
      if (word < this._minFreeWord) {
        this._minFreeWord = word;
      }
    }
  }

  public owns(id: number): boolean {
    return id >= this.min && (this.max === undefined || id <= this.max);
  }

  public reserve(id: number): void {
    if (!this.owns(id)) {
      throw new Error(`Id ${id} does not belong to pool '${this.name}'`);
    }
    const offset = id - this.min;
    const word = offset >>> 5;
    this._growBits(word + 1);
    const mask = 1 << offset;
    const cur = this._bits[word];
    if ((cur & mask) !== 0) {
      throw new Error(`Id ${id} is already reserved`);
    }
    this._bits[word] = cur | mask;
    if (id < this._next) {
      this._freeBelowNext--;
    }
  }

  private _growBits(length: number): void {
    const bits = this._bits;
    while (bits.length < length) {
      bits.push(0);
    }
  }
}

function ctz32(x: number): number {
  // For x with at least one set bit, returns the index of the lowest set bit.
  // The IdPool callers guarantee the input has at least one set bit.
  return 31 - Math.clz32(x & -x);
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
