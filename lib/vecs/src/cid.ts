/** A component id packs an entity id and component type id into a uint32. */
export type CID = number;

/** Component type ids below this value are reserved for externally assigned ids. */
export let LOCAL_COMPONENT_MIN = 256;

let componentTypeMask = LOCAL_COMPONENT_MIN - 1;
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
  if (isAlignedLocalComponentMin(value)) {
    getLocalComponentMin();
    componentTypeMask = LOCAL_COMPONENT_MIN - 1;
    componentTypeShift = Math.log2(LOCAL_COMPONENT_MIN);
  }
}

/** Pack an entity id and component type id into a uint32 component id. */
export function cid_pack(eid: number, type: number): CID {
  return ((eid << componentTypeShift) | (type & componentTypeMask)) >>> 0;
}

/** Unpack a uint32 component id into [entity id, component type id]. */
export function cid_unpack(cid: CID): [eid: number, type: number] {
  return [cid >>> componentTypeShift, cid & componentTypeMask];
}
