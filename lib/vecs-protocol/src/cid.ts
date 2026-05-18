/** A component id packs an entity id and component type id into a uint32. */
export type CID = number;

/** Component type ids below this value can fit into packed wire component ids. */
export let LOCAL_COMPONENT_MIN = 256;

/** Protocol removal marker for all components on an entity. */
export const ALL_COMPONENTS = 0;

let componentTypeMask = LOCAL_COMPONENT_MIN - 1;
let componentTypeShift = Math.log2(LOCAL_COMPONENT_MIN);
let MAX_ENTITY_ID = 2 ** (32 - componentTypeShift) - 1;
let MAX_COMPONENT_TYPE = componentTypeMask;

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

/** Configure the local component type range before constructing networked worlds. */
export function setLocalComponentMin(value: number): void {
  LOCAL_COMPONENT_MIN = value;
  if (isAlignedLocalComponentMin(value)) {
    getLocalComponentMin();
    componentTypeMask = LOCAL_COMPONENT_MIN - 1;
    componentTypeShift = Math.log2(LOCAL_COMPONENT_MIN);
    MAX_ENTITY_ID = 2 ** (32 - componentTypeShift) - 1;
    MAX_COMPONENT_TYPE = componentTypeMask;
  }
}

/** Pack an entity id and component type id into a uint32 component id. */
export function cid_pack(eid: number, type: number): CID {
  if (eid < 0) {
    throw new Error(`cid_pack: entity id must be non-negative, got ${eid}`);
  }

  if (eid > MAX_ENTITY_ID) {
    throw new Error(
      `cid_pack: entity id ${eid} exceeds maximum ${MAX_ENTITY_ID} for LOCAL_COMPONENT_MIN=${LOCAL_COMPONENT_MIN}. ` +
        `Increase LOCAL_COMPONENT_MIN or use a smaller entity id.`
    );
  }

  if (type < 0) {
    throw new Error(`cid_pack: type id must be non-negative, got ${type}`);
  }

  if (type > MAX_COMPONENT_TYPE) {
    throw new Error(
      `cid_pack: type id ${type} exceeds maximum component type ${MAX_COMPONENT_TYPE}. ` +
        `Ensure type id is less than LOCAL_COMPONENT_MIN=${LOCAL_COMPONENT_MIN}.`
    );
  }

  return ((eid << componentTypeShift) | (type & componentTypeMask)) >>> 0;
}

/** Unpack a uint32 component id into [entity id, component type id]. */
export function cid_unpack(cid: CID): [eid: number, type: number] {
  return [cid >>> componentTypeShift, cid & componentTypeMask];
}
