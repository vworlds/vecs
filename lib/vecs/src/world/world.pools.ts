import { IdPool, type IdPoolConfig, validateIdPoolConfigs } from "../util/id_pool.js";
import { Base, type WorldOptions } from "./world.base.js";

const RESERVED_EID = 0;

export const DEFAULT_POOLS: readonly IdPoolConfig[] = [
  { name: "component", min: 1, max: 899 },
  { name: "module", min: 900, max: 999 },
  { name: "entity", min: 1000 },
];

export class Pools extends Base {
  /** @internal Baked id pool configs for this world. */
  protected readonly _poolConfigs: IdPoolConfig[] = [];
  /** @internal Runtime allocators for every configured id range. */
  protected readonly _pools: IdPool[] = [];
  /** @internal Allocator used by component registration. */
  protected _componentPool!: IdPool;
  /** @internal Allocator used by module registration. */
  protected _modulePool!: IdPool;
  /** @internal Allocator used by ordinary entity creation. */
  protected _entityPool!: IdPool;

  public constructor(options: WorldOptions = {}) {
    super();
    const idPools = options.idPools ?? DEFAULT_POOLS;
    validateIdPoolConfigs(idPools);
    this._poolConfigs.push(...idPools.map((pool) => ({ ...pool })));
    this._pools.push(
      ...this._poolConfigs.map(
        (pool) => new IdPool(pool.name, pool.min, pool.max, pool.reuseWaitFrames)
      )
    );
    this._cacheNamedPools();
  }

  public get pools(): ReadonlyArray<IdPoolConfig> {
    return this._poolConfigs.map((pool) => ({ ...pool }));
  }

  /** Return the id that the named pool will allocate next without reserving it. */
  public peekNextEid(poolName: string): number {
    return this._poolByName(poolName).peek();
  }

  /** @internal Cache the well-known pools used by hot paths. */
  protected _cacheNamedPools(): void {
    this._componentPool = this._poolByName("component");
    this._modulePool = this._poolByName("module");
    this._entityPool = this._poolByName("entity");
  }

  /** @internal Advance every id pool waitlist by one frame. */
  protected _advanceIdPoolFrame(): void {
    this._pools.forEach((pool) => pool.advanceFrame());
  }

  /** @internal Look up a configured id pool by name. */
  protected _poolByName(name: string): IdPool {
    const pool = this._pools.find((candidate) => candidate.name === name);
    if (!pool) {
      throw new Error(`Unknown id pool '${name}'`);
    }
    return pool;
  }

  /** @internal Return the pool that owns `eid`. */
  protected _poolFor(eid: number): IdPool {
    if (eid === RESERVED_EID) {
      throw new Error(`Eid ${eid} is reserved`);
    }
    const pool = this._pools.find((candidate) => candidate.owns(eid));
    if (!pool) {
      throw new Error(`No id pool owns eid ${eid}`);
    }
    return pool;
  }

  /** @internal Reserve an externally assigned id in its owning pool. */
  protected _reserveEid(eid: number): void {
    this._poolFor(eid).reserve(eid);
  }
}
