import { expect, expectTypeOf, test, vi } from "vitest";
import {
  ComponentSnapshot as WireSnapshot,
  EncodedSnapshot,
  StateDiff,
} from "@vworlds/vecs-protocol";
import { Encoder } from "@vworlds/vecs-wire";
import { ComponentSnapshot, Diff, diffFromStateDiff, merge } from "../src/diff_buffer.js";

function snapshot(eid: number): ComponentSnapshot {
  return new ComponentSnapshot(eid, 1, new Uint8Array([eid]));
}

test("snapshots is a read-only getter and array type", () => {
  const diff = new Diff(0, 1);
  expectTypeOf(diff.snapshots).toEqualTypeOf<readonly ComponentSnapshot[]>();
  expect(Reflect.set(diff, "snapshots", [])).toBe(false);
  expect(diff.snapshots).toEqual([]);
});

test("wire order survives merge, replacement and appended cids", () => {
  const wire = new StateDiff({
    toFrame: 1,
    snapshots: [3, 1, 2].map((eid) => {
      const encoder = new Encoder(new Uint8Array(64));
      encoder.write(new WireSnapshot({ eid, wireType: 1, payload: new Uint8Array([eid]) }));
      return new EncodedSnapshot(encoder.getBuffer());
    }),
  });
  const a = diffFromStateDiff(wire);
  expect(a.snapshots.map((s) => s.eid)).toEqual([3, 1, 2]);
  const b = new Diff(1, 2);
  const replacement = snapshot(1);
  b.upsertSnapshot(replacement);
  b.upsertSnapshot(snapshot(4));
  for (const mutate of [false, true]) {
    const result = merge(a, b, true, mutate);
    expect(result.snapshots.map((s) => s.eid)).toEqual([3, 1, 2, 4]);
    expect(result.getSnapshot(replacement.cid)).toBe(replacement);
    const newer = snapshot(3);
    result.upsertSnapshot(newer);
    expect(result.snapshots.map((s) => s.eid)).toEqual([3, 1, 2, 4]);
    expect(result.snapshots[0]).toBe(newer);
  }
});

test("snapshot arrays are cached and materialized only on read after edits", () => {
  const diff = new Diff(0, 1);
  const original = snapshot(1);
  diff.upsertSnapshot(original);
  const initial = diff.snapshots;
  // Observe iteration of the backing map, not elapsed time or private fields.
  const values = vi.spyOn(diff.smap, "values");
  try {
    diff.upsertSnapshot(snapshot(1));
    diff.upsertSnapshot(snapshot(2));
    expect(values).not.toHaveBeenCalled();
    expect(initial).toEqual([original]);
    const updated = diff.snapshots;
    expect(updated.map((s) => s.eid)).toEqual([1, 2]);
    expect(values).toHaveBeenCalledTimes(1);
    expect(diff.snapshots).toBe(updated);
    diff.getSnapshot(original.cid);
    expect(diff.snapshots).toBe(updated);
    diff.deleteSnapshot(original.cid);
    expect(diff.snapshots.map((s) => s.eid)).toEqual([2]);
    expect(values).toHaveBeenCalledTimes(2);
    const remaining = diff.snapshots;
    diff.deleteSnapshot(original.cid);
    expect(diff.snapshots).toBe(remaining);
  } finally {
    values.mockRestore();
  }
});

test("merge without removals allocates no Set, including explicit empty lists", () => {
  for (const removed of [undefined, []]) {
    for (const mutate of [false, true]) {
      const a = new Diff(0, 1, removed);
      const b = new Diff(1, 2, removed);
      a.upsertSnapshot(snapshot(1));
      b.upsertSnapshot(snapshot(2));
      let allocations = 0;
      const CountingSet = new Proxy(Set, {
        construct(target, args) {
          allocations++;
          return Reflect.construct(target, args);
        },
      });
      let result: Diff;
      vi.stubGlobal("Set", CountingSet);
      try {
        result = merge(a, b, true, mutate);
      } finally {
        vi.unstubAllGlobals();
      }
      expect(allocations).toBe(0);
      expect(result.removed).toBeUndefined();
      expect(result.snapshots.map((s) => s.eid)).toEqual([1, 2]);
    }
  }
});
