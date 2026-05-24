import { World, type ComponentClass, type IdPoolConfig, type WorldOptions } from "@vworlds/vecs";
import { setLocalComponentMin } from "./cid.js";

const DEFAULT_ENTITY_ID_START = 1000;
let configuredLocalComponentMin: number | undefined;

export interface RegisteredNetworkComponent {
  Class: ComponentClass;
  type: number;
}

export interface NetworkWorldOptions extends Omit<WorldOptions, "idPools"> {
  networkComponents?: readonly ComponentClass[];
  entityIdStart?: number;
  localEntityIdStart?: number;
}

export class NetworkWorld extends World {
  public readonly localComponentMin: number;
  public readonly networkComponents: readonly RegisteredNetworkComponent[];

  public constructor(options: NetworkWorldOptions = {}) {
    const networkComponents = options.networkComponents ?? [];
    const localComponentMin = getLocalComponentMinFor(networkComponents.length);
    configureLocalComponentMin(localComponentMin);
    super({
      idPools: buildNetworkIdPools(localComponentMin, options),
    });

    this.localComponentMin = localComponentMin;
    this.networkComponents = networkComponents.map((Class, index) => {
      const type = index + 1;
      this.component(Class, type);
      return { Class, type };
    });
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

function buildNetworkIdPools(
  localComponentMin: number,
  options: NetworkWorldOptions
): IdPoolConfig[] {
  const entityIdStart = options.entityIdStart ?? DEFAULT_ENTITY_ID_START;
  validateEntityStart("entityIdStart", entityIdStart);
  if (entityIdStart <= localComponentMin) {
    throw new Error("entityIdStart must leave room for local component ids");
  }

  const pools: IdPoolConfig[] = [
    { name: "network", min: 1, max: localComponentMin - 1 },
    { name: "component", min: localComponentMin, max: entityIdStart - 1 },
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

  pools.push(
    { name: "network_entity", min: entityIdStart, max: localEntityIdStart - 1 },
    { name: "entity", min: localEntityIdStart }
  );
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

function validateEntityStart(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
