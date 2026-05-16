/** A component id packs an entity id and component type id into a uint32. */
export type CID = number;

/** Component type ids below this value are reserved for externally assigned ids. */
export let LOCAL_COMPONENT_MIN = 256;

/** Reserved component type id with all component-type bits set. */
export let ALL_COMPONENTS = LOCAL_COMPONENT_MIN - 1;

let componentTypeMask = ALL_COMPONENTS;
let componentTypeShift = Math.log2(LOCAL_COMPONENT_MIN);

function validateLocalComponentMin(value: number): void {
  if (!isAlignedLocalComponentMin(value)) {
    throw new Error("LOCAL_COMPONENT_MIN must be a power-of-two safe integer >= 2");
  }
  if (Math.log2(value) > 31) {
    throw new Error("LOCAL_COMPONENT_MIN must reserve fewer than 32 component type bits");
  }
}

function isAlignedLocalComponentMin(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 2 && (value & (value - 1)) === 0;
}

/** Return the configured local component minimum after validating its alignment. */
export function getLocalComponentMin(): number {
  validateLocalComponentMin(LOCAL_COMPONENT_MIN);
  return LOCAL_COMPONENT_MIN;
}

/** Configure the local component type range before constructing any worlds. */
export function setLocalComponentMin(value: number): void {
  LOCAL_COMPONENT_MIN = value;
  ALL_COMPONENTS = LOCAL_COMPONENT_MIN - 1;
  if (isAlignedLocalComponentMin(value)) {
    getLocalComponentMin();
    componentTypeMask = ALL_COMPONENTS;
    componentTypeShift = Math.log2(LOCAL_COMPONENT_MIN);
  }
}

/** Pack an entity id and component type id into a uint32 component id. */
export function cid_pack(eid: number, type: number): CID {
  const maxEid = (1 << (32 - componentTypeShift)) - 1;
  const maxType = componentTypeMask;

  if (eid < 0) {
    throw new Error(`cid_pack: entity id must be non-negative, got ${eid}`);
  }

  if (eid > maxEid) {
    throw new Error(
      `cid_pack: entity id ${eid} exceeds maximum ${maxEid} for LOCAL_COMPONENT_MIN=${LOCAL_COMPONENT_MIN}. ` +
        `Increase LOCAL_COMPONENT_MIN or use a smaller entity id.`
    );
  }

  if (type < 0) {
    throw new Error(`cid_pack: type id must be non-negative, got ${type}`);
  }

  if (type > maxType) {
    throw new Error(
      `cid_pack: type id ${type} exceeds maximum component type ${maxType}. ` +
        `Ensure type id is less than LOCAL_COMPONENT_MIN=${LOCAL_COMPONENT_MIN}.`
    );
  }

  return ((eid << componentTypeShift) | (type & componentTypeMask)) >>> 0;
}

/** Unpack a uint32 component id into [entity id, component type id]. */
export function cid_unpack(cid: CID): [eid: number, type: number] {
  return [cid >>> componentTypeShift, cid & componentTypeMask];
}
