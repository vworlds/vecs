import type { EID } from "@vworlds/vecs";

/** A component id packs an entity id and wire type id into a uint32. */
export type CID = number;

/** Protocol removal marker for all components on an entity. */
export const ALL_COMPONENTS = 0;

/** Immutable packing rules owned by one network world's wire schema. */
export class CidLayout {
  /** Number of low bits reserved for the wire type. */
  public readonly wireTypeShift: number;
  /** Mask selecting the wire type from a packed id. */
  public readonly wireTypeMask: number;
  /** Largest entity id representable without truncation. */
  public readonly maxEntityId: number;
  /** Largest wire type representable without truncation. */
  public readonly maxWireType: number;

  /**
   * Build a layout from a power-of-two safe integer in [2, 2^31).
   * Invalid input throws before any layout is initialized.
   */
  public constructor(public readonly localComponentMin: number) {
    if (
      !Number.isSafeInteger(localComponentMin) ||
      localComponentMin < 2 ||
      !Number.isInteger(Math.log2(localComponentMin))
    ) {
      throw new Error("localComponentMin must be a power-of-two safe integer >= 2");
    }
    if (localComponentMin >= 2 ** 31) {
      throw new Error("localComponentMin must reserve fewer than 31 wire type bits");
    }
    this.wireTypeShift = Math.log2(localComponentMin);
    this.wireTypeMask = localComponentMin - 1;
    this.maxEntityId = 2 ** (32 - this.wireTypeShift) - 1;
    this.maxWireType = this.wireTypeMask;
  }

  /** Pack an entity id and wire type into a uint32; throw on negative or overflowing ids. */
  public pack(eid: EID, wireType: number): CID {
    if (eid < 0) {
      throw new Error(`cid_pack: entity id must be non-negative, got ${eid}`);
    }
    if (eid > this.maxEntityId) {
      throw new Error(
        `cid_pack: entity id ${eid} exceeds maximum ${this.maxEntityId} for localComponentMin=${this.localComponentMin}. ` +
          `Increase localComponentMin or use a smaller entity id.`
      );
    }
    if (wireType < 0) {
      throw new Error(`cid_pack: wire type id must be non-negative, got ${wireType}`);
    }
    if (wireType > this.maxWireType) {
      throw new Error(
        `cid_pack: wire type id ${wireType} exceeds maximum wire type ${this.maxWireType}. ` +
          `Ensure wire type id is less than localComponentMin=${this.localComponentMin}.`
      );
    }
    return ((eid << this.wireTypeShift) | (wireType & this.wireTypeMask)) >>> 0;
  }

  /** Unpack a uint32 component id using this world's wire schema. */
  public unpack(cid: CID): [eid: EID, wireType: number] {
    return [cid >>> this.wireTypeShift, cid & this.wireTypeMask];
  }
}
