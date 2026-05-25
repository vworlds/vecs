import { type IdPoolConfig } from "../util/id_pool.js";

export interface WorldOptions {
  idPools?: readonly IdPoolConfig[];
}

export class Base {
  /** Hidden property key used to store this world's meta on component classes. */
  public readonly worldKey = `__vecs_world_${Math.random().toString(36).slice(2)}`;
}
