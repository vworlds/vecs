import { describe, it, expect, beforeEach } from "vitest";
import {
  cid_pack,
  cid_unpack,
  LOCAL_COMPONENT_MIN,
  setLocalComponentMin,
  ALL_COMPONENTS,
} from "../src/cid.js";

describe("cid_pack", () => {
  beforeEach(() => {
    setLocalComponentMin(256);
  });

  it("packs and unpacks entity 0 with type 0", () => {
    const cid = cid_pack(0, 0);
    const [eid, type] = cid_unpack(cid);
    expect(eid).toBe(0);
    expect(type).toBe(0);
  });

  it("packs and unpacks default boundary case", () => {
    const maxEid = 16777215;
    const maxType = 255;

    const cid = cid_pack(maxEid, maxType);
    const [eid, type] = cid_unpack(cid);
    expect(eid).toBe(maxEid);
    expect(type).toBe(maxType);
  });

  it("reverses cid_pack with cid_unpack", () => {
    const testCases = [
      [0, 0],
      [1, 0],
      [255, 1],
      [16777215, 255],
      [1000, 100],
    ];

    for (const [eid, type] of testCases) {
      const cid = cid_pack(eid, type);
      const [unpackedEid, unpackedType] = cid_unpack(cid);
      expect([unpackedEid, unpackedType]).toEqual([eid, type]);
    }
  });

  it("throws on negative entity id", () => {
    expect(() => cid_pack(-1, 0)).toThrow(/entity id must be non-negative/);
  });

  it("throws on entity id at boundary + 1", () => {
    const maxEid = 16777215;
    expect(() => cid_pack(maxEid + 1, 0)).toThrow(/exceeds maximum/);
  });

  it("throws on entity id far exceeding boundary", () => {
    expect(() => cid_pack(2 ** 24, 0)).toThrow(/exceeds maximum/);
    expect(() => cid_pack(2 ** 30, 0)).toThrow(/exceeds maximum/);
  });

  it("throws on negative type id", () => {
    expect(() => cid_pack(0, -1)).toThrow(/type id must be non-negative/);
  });

  it("throws on type id exceeding componentTypeMask", () => {
    expect(() => cid_pack(0, 256)).toThrow(/exceeds maximum component type/);
  });

  it("accepts type id equal to ALL_COMPONENTS sentinel", () => {
    expect(() => cid_pack(0, ALL_COMPONENTS)).not.toThrow();
    const cid = cid_pack(0, ALL_COMPONENTS);
    const [eid, type] = cid_unpack(cid);
    expect(eid).toBe(0);
    expect(type).toBe(ALL_COMPONENTS);
  });

  it("works with custom LOCAL_COMPONENT_MIN = 64", () => {
    setLocalComponentMin(64);
    const componentTypeShift = 6;
    const maxEid = (1 << (32 - componentTypeShift)) - 1;

    const cid = cid_pack(maxEid, 63);
    const [eid, type] = cid_unpack(cid);
    expect(eid).toBe(maxEid);
    expect(type).toBe(63);
    expect(() => cid_pack(maxEid + 1, 0)).toThrow(/exceeds maximum/);
  });

  it("works with custom LOCAL_COMPONENT_MIN = 1024", () => {
    setLocalComponentMin(1024);
    const componentTypeShift = 10;
    const maxEid = (1 << (32 - componentTypeShift)) - 1;

    const cid = cid_pack(maxEid, 1023);
    const [eid, type] = cid_unpack(cid);
    expect(eid).toBe(maxEid);
    expect(type).toBe(1023);
    expect(() => cid_pack(maxEid + 1, 0)).toThrow(/exceeds maximum/);
  });
});
