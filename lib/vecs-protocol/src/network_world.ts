import {
  World,
  type ComponentClass,
  type EID,
  type IdPoolConfig,
  type WorldOptions,
  Relationship,
} from "@vworlds/vecs";
import { wireType } from "@vworlds/vecs-wire";
import { cid_pack, setLocalComponentMin } from "./cid.js";

// Register Relationship.target as an "entity" wire field so every Relationship
// subclass (ChildOf, custom relationships, etc.) inherits the wire serialization
// of target as a u32 entity id. The decoder writes a raw number into `target`;
// the client resolves it to a live Entity in _applySnapshot. This must run once
// at module load, before any Relationship subclass is encoded or decoded.
wireType("entity")(Relationship.prototype, "target");

const DEFAULT_ENTITY_ID_START = 1000;
const MODULE_ID_RANGE_SIZE = 100;
let configuredLocalComponentMin: number | undefined;

export interface RegisteredNetworkComponent {
  Class: ComponentClass;
  wireType: number;
  eid: EID;
}

export interface NetworkWorldOptions extends Omit<WorldOptions, "idPools"> {
  networkComponents?: readonly ComponentClass[];
  entityIdStart?: EID;
  localEntityIdStart?: EID;
  networkEntityReuseWaitFrames?: number;
}

export class NetworkWorld extends World {
  public readonly localComponentMin: number;
  public readonly networkComponents: readonly RegisteredNetworkComponent[];
  private readonly _networkComponentsByType = new Map<number, RegisteredNetworkComponent>();

  public constructor(options: NetworkWorldOptions = {}) {
    const networkComponents = options.networkComponents ?? [];
    const localComponentMin = getLocalComponentMinFor(networkComponents.length);
    configureLocalComponentMin(localComponentMin);
    super({
      idPools: buildNetworkIdPools(options),
    });

    this.localComponentMin = localComponentMin;
    this.networkComponents = networkComponents.map((Class, index) => {
      const wireType = index + 1;
      cid_pack(0, wireType);
      // Auto-allocate the component's internal eid from the "component" pool.
      // The wire type id (index + 1) is tracked separately for wire encoding
      // and is independent of the component's internal eid. Built-in
      // relationships like ChildOf are pre-registered by RelationshipsModule;
      // this.component returns the existing entity in that case.
      const eid = this.component(Class).eid;
      const registered = { Class, wireType, eid };
      this._networkComponentsByType.set(wireType, registered);
      return registered;
    });
  }

  public getNetworkComponent(wireType: number): RegisteredNetworkComponent | undefined {
    return this._networkComponentsByType.get(wireType);
  }
}

function configureLocalComponentMin(localComponentMin: number): void {
  if (configuredLocalComponentMin === undefined) {
    configuredLocalComponentMin = localComponentMin;
    setLocalComponentMin(localComponentMin);
    return;
  }
  if (configuredLocalComponentMin !== localComponentMin) {
    throw new Error(
      `NetworkWorld localComponentMin ${localComponentMin} does not match existing value ${configuredLocalComponentMin}`
    );
  }
  setLocalComponentMin(localComponentMin);
}

function buildNetworkIdPools(options: NetworkWorldOptions): IdPoolConfig[] {
  const entityIdStart = options.entityIdStart ?? DEFAULT_ENTITY_ID_START;
  validateEntityStart("entityIdStart", entityIdStart);
  const moduleIdStart = entityIdStart - MODULE_ID_RANGE_SIZE;
  if (moduleIdStart <= 0) {
    throw new Error("entityIdStart must leave room for module ids");
  }

  const pools: IdPoolConfig[] = [
    { name: "component", min: 1, max: moduleIdStart - 1 },
    { name: "module", min: moduleIdStart, max: entityIdStart - 1 },
  ];

  if (options.localEntityIdStart === undefined) {
    pools.push({ name: "entity", min: entityIdStart });
    return pools;
  }

  const localEntityIdStart = options.localEntityIdStart;
  validateEntityStart("localEntityIdStart", localEntityIdStart);
  if (localEntityIdStart <= entityIdStart) {
    throw new Error("localEntityIdStart must be greater than entityIdStart");
  }

  const networkEntityPool: IdPoolConfig = {
    name: "network_entity",
    min: entityIdStart,
    max: localEntityIdStart - 1,
  };
  if (options.networkEntityReuseWaitFrames !== undefined) {
    networkEntityPool.reuseWaitFrames = options.networkEntityReuseWaitFrames;
  }

  pools.push(networkEntityPool, { name: "entity", min: localEntityIdStart });
  return pools;
}

function getLocalComponentMinFor(networkComponentCount: number): number {
  return nextPowerOfTwo(Math.max(2, networkComponentCount + 1));
}

function nextPowerOfTwo(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Network component count must be a positive safe integer");
  }

  let power = 1;
  while (power < value) {
    power *= 2;
  }
  return power;
}

function validateEntityStart(name: string, value: EID): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
