import type { EID } from "@vworlds/vecs";

/** A component id packs an entity id and wire type id into a uint32. */
export type CID = number;

/** Wire type ids below this value can fit into packed wire component ids. */
export let LOCAL_COMPONENT_MIN = 256;

/** Protocol removal marker for all components on an entity. */
export const ALL_COMPONENTS = 0;

let wireTypeMask = LOCAL_COMPONENT_MIN - 1;
let wireTypeShift = Math.log2(LOCAL_COMPONENT_MIN);
let MAX_ENTITY_ID = 2 ** (32 - wireTypeShift) - 1;
let MAX_WIRE_TYPE = wireTypeMask;

function validateLocalComponentMin(value: number): void {
  if (!isAlignedLocalComponentMin(value)) {
    throw new Error("LOCAL_COMPONENT_MIN must be a power-of-two safe integer >= 2");
  }
  if (Math.log2(value) > 31) {
    throw new Error("LOCAL_COMPONENT_MIN must reserve fewer than 32 wire type bits");
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

/** Configure the local wire type range before constructing networked worlds. */
export function setLocalComponentMin(value: number): void {
  validateLocalComponentMin(value);
  LOCAL_COMPONENT_MIN = value;
  wireTypeMask = value - 1;
  wireTypeShift = Math.log2(value);
  MAX_ENTITY_ID = 2 ** (32 - wireTypeShift) - 1;
  MAX_WIRE_TYPE = wireTypeMask;
}

/** Pack an entity id and wire type id into a uint32 component id. */
export function cid_pack(eid: EID, wireType: number): CID {
  if (eid < 0) {
    throw new Error(`cid_pack: entity id must be non-negative, got ${eid}`);
  }

  if (eid > MAX_ENTITY_ID) {
    throw new Error(
      `cid_pack: entity id ${eid} exceeds maximum ${MAX_ENTITY_ID} for LOCAL_COMPONENT_MIN=${LOCAL_COMPONENT_MIN}. ` +
        `Increase LOCAL_COMPONENT_MIN or use a smaller entity id.`
    );
  }

  if (wireType < 0) {
    throw new Error(`cid_pack: wire type id must be non-negative, got ${wireType}`);
  }

  if (wireType > MAX_WIRE_TYPE) {
    throw new Error(
      `cid_pack: wire type id ${wireType} exceeds maximum wire type ${MAX_WIRE_TYPE}. ` +
        `Ensure wire type id is less than LOCAL_COMPONENT_MIN=${LOCAL_COMPONENT_MIN}.`
    );
  }

  return ((eid << wireTypeShift) | (wireType & wireTypeMask)) >>> 0;
}

/** Unpack a uint32 component id into [entity id, wire type id]. */
export function cid_unpack(cid: CID): [eid: EID, wireType: number] {
  return [cid >>> wireTypeShift, cid & wireTypeMask];
}
