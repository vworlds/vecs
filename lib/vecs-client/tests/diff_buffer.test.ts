import { expect, test } from "vitest";
import { cid_pack } from "@vworlds/vecs-protocol";
import type { EID } from "@vworlds/vecs";
import { Encoder, Decoder } from "@vworlds/vecs-wire";
import {
  ComponentSnapshot,
  Diff,
  DiffBuffer,
  MAX_HELD_DIFFS,
  interpolatePosition,
  merge,
  type ComponentInterpolator,
} from "../src/diff_buffer.js";

const PositionWireType = 1;
const ColorWireType = 6;

class Position {
  public x = 0;
  public y = 0;
}

function CID(eid: EID, wireType: number): number {
  return cid_pack(eid, wireType);
}

function sortSnapshots(snapshots: ComponentSnapshot[]): ComponentSnapshot[] {
  return [...snapshots].sort((a, b) => a.cid - b.cid);
}

function encodePos(x: number, y: number): Uint8Array {
  const e = new Encoder(new Uint8Array(8));
  e.write_i32(x);
  e.write_i32(y);
  return e.getBuffer();
}

function encodeColor(color: string): Uint8Array {
  const e = new Encoder(new Uint8Array(64));
  e.write_string(color);
  return e.getBuffer();
}

function makePosComponent(eid: EID, x: number, y: number): ComponentSnapshot {
  return new ComponentSnapshot(eid, PositionWireType, encodePos(x, y));
}

function makeColorComponent(eid: EID, color: string): ComponentSnapshot {
  return new ComponentSnapshot(eid, ColorWireType, encodeColor(color));
}

// test snapshot generator: returns Position + Color components for one entity
function snap({ id, xy, color }: { id: EID; xy: number; color: string }): ComponentSnapshot[] {
  return [makePosComponent(id, xy, xy), makeColorComponent(id, color)];
}

// test Diff generator
function SD(p: {
  from: number;
  to: number;
  removed?: number[];
  resets?: Array<[EID, number]>;
  snapshots: ComponentSnapshot[];
}): Diff {
  const d = new Diff(p.from, p.to, p.removed);
  d.snapshots = p.snapshots;
  if (p.resets) {
    d.resets = new Map(p.resets);
  }
  return d;
}

function hasMaterializedSnapshotMap(diff: Diff): boolean {
  return (diff as unknown as { _smap?: Map<number, ComponentSnapshot> })._smap !== undefined;
}

function Color(sd: Diff, id: EID): string | undefined {
  const s = sd.smap.get(CID(id, ColorWireType));
  if (!s) {
    return undefined;
  }
  if (!(s.payload instanceof Uint8Array)) {
    throw new Error("Color payload must be encoded bytes");
  }
  return new Decoder(s.payload).read_string();
}

function Pos(sd: Diff, id: EID): { x: number; y: number } | undefined {
  const s = sd.smap.get(CID(id, PositionWireType));
  if (!s) {
    return undefined;
  }
  if (!(s.payload instanceof Uint8Array)) {
    const p = s.payload as Position;
    return { x: p.x, y: p.y };
  }
  const d = new Decoder(s.payload);
  return { x: d.read_i32(), y: d.read_i32() };
}

function decodePosition(snapshot: ComponentSnapshot): Position {
  if (!(snapshot.payload instanceof Uint8Array)) {
    return snapshot.payload as Position;
  }
  const d = new Decoder(snapshot.payload);
  const position = new Position();
  position.x = d.read_i32();
  position.y = d.read_i32();
  snapshot.payload = position;
  return position;
}

function newDiffBuffer(maxLength: number, serverTickInterval: number): DiffBuffer {
  return new DiffBuffer(maxLength, serverTickInterval, decodePosition, [
    [PositionWireType, interpolatePosition],
  ]);
}

const A = 1;
const B = 2;
const C = 3;
const D = 4;

test("reorder", () => {
  const MAX_LENGTH = 4;
  let ip = newDiffBuffer(MAX_LENGTH, 10);
  const s0 = SD({ from: 0, to: 0, snapshots: snap({ id: A, xy: 0, color: "red" }) });
  const s1 = SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) });
  const s2 = SD({ from: 0, to: 2, snapshots: snap({ id: A, xy: 2, color: "red" }) });
  const s3 = SD({ from: 0, to: 3, snapshots: snap({ id: A, xy: 3, color: "red" }) });

  ip.push(s0);
  ip.push(s3);
  ip.push(s2);
  ip.push(s1);

  expect(ip.bucket[0]).toBe(s0);
  expect(ip.bucket[1]).toBe(s1);
  expect(ip.bucket[2]).toBe(s2);
  expect(ip.bucket[3]).toBe(s3);
  expect(ip.version).toBe(3);

  // Try again, but this case s2 arrives first. When the bucket is empty,
  // the first diff received is taken as starting point
  ip = newDiffBuffer(MAX_LENGTH, 10);
  ip.push(s2); // taken as starting reference and placed in bucket[0]
  ip.push(s0); // will be discarded as too old
  ip.push(s3); // will be placed in bucket[1]
  ip.push(s1); // will be discarded as too old

  expect(ip.bucket[0]).toBe(s2);
  expect(ip.bucket[1]).toBe(s3);
  expect(ip.bucket[2]).toBeUndefined();
  expect(ip.bucket[3]).toBeUndefined();
  expect(ip.version).toBe(3);

  // if now s6 arrives, would fall in bucket[4] (out of bounds), so to make
  // space, s3 has to merge on to s2
  const s6 = SD({ from: ip.version, to: 6, snapshots: snap({ id: A, xy: 6, color: "red" }) });
  ip.push(s6);

  expect(ip.bucket[0]).toStrictEqual(merge(s2, s3));
  expect(ip.bucket[1]).toBeUndefined();
  expect(ip.bucket[2]).toBeUndefined();
  expect(ip.bucket[3]).toBe(s6);

  const s18 = SD({ from: ip.version, to: 18, snapshots: snap({ id: A, xy: 18, color: "red" }) });

  // if now s18 arrives (we are far behind), everything is merged on bucket[0]
  ip.push(s18);

  expect(ip.bucket[0]).toStrictEqual(merge(merge(merge(s2, s3), s6), s18));
  expect(ip.bucket[1]).toBeUndefined();
  expect(ip.bucket[2]).toBeUndefined();
  expect(ip.bucket[3]).toBeUndefined();
  expect(ip.version).toBe(18);
});

test("pull steps through buffered frames with interpolated position frames", () => {
  const MAX_LENGTH = 4;
  const ip = newDiffBuffer(MAX_LENGTH, 10);

  const A1 = snap({ id: A, xy: 0, color: "red" });
  const B1 = snap({ id: B, xy: 5, color: "blue" });
  const A2 = snap({ id: A, xy: 1, color: "black" });
  const C2 = snap({ id: C, xy: 4, color: "green" });
  // s3 is intentionally missing
  const A4 = snap({ id: A, xy: 3, color: "red" });
  const B4 = snap({ id: B, xy: 10, color: "yellow" });
  const D4 = snap({ id: D, xy: 7, color: "purple" });

  const s1 = SD({ from: 0, to: 1, snapshots: [...A1, ...B1] });
  const s2 = SD({ from: 1, to: 2, snapshots: [...A2, ...C2] });
  const s4 = SD({ from: 2, to: 4, snapshots: [...A4, ...B4, ...D4] });

  ip.push(s1);
  ip.push(s2);
  ip.push(s4);

  let now = 100;
  const sd100 = ip.pull(now);
  // First pull initializes tServ to `now` and immediately consumes s1
  // (the loop body runs once before incrementing tServ). The result has
  // from=0 (the initial stateVersion) and to=1 (s1.to).
  expect(sd100.from).toBe(0);
  expect(sd100.to).toBe(1);
  expect(Pos(sd100, A)).toEqual({ x: 0, y: 0 });
  expect(Pos(sd100, B)).toEqual({ x: 5, y: 5 });

  now += 5; // 105: not enough server-time has elapsed, expect an interpolated frame
  const sd105 = ip.pull(now);
  expect(Pos(sd105, A)).toEqual({ x: 0.5, y: 0.5 });
  expect(sd105.removed ?? []).toEqual([]);
  expect(sd105.from).toBe(1);
  expect(sd105.to).toBe(1);

  now += 10; // 115: tServ advances past s2 and starts interpolating toward s4.
  const sd115 = ip.pull(now);
  expect(Pos(sd115, A)).toEqual({ x: 1.5, y: 1.5 });
  expect(Color(sd115, A)).toBe("black");
  expect(Pos(sd115, C)).toEqual({ x: 4, y: 4 });
  expect(sd115.from).toBe(1);
  expect(sd115.to).toBe(2);

  now += 10; // 125: still waiting for s3 (missing) / s4 server slot
  const sd125 = ip.pull(now);
  expect(Pos(sd125, A)).toEqual({ x: 2.5, y: 2.5 });
  expect(Pos(sd125, B)).toEqual({ x: 8.75, y: 8.75 });
  expect(sd125.from).toBe(2);
  expect(sd125.to).toBe(2);

  now += 10; // 135: tServ has now advanced past s4; consume s4.
  const sd135 = ip.pull(now);
  expect(Pos(sd135, A)).toEqual({ x: 3, y: 3 });
  expect(Pos(sd135, B)).toEqual({ x: 10, y: 10 });
  expect(Pos(sd135, D)).toEqual({ x: 7, y: 7 });
  expect(sd135.from).toBe(2);
  expect(sd135.to).toBe(4);

  // invoking pull() again after the buffer is empty returns an empty diff
  const lastsd = ip.pull(now);
  expect(lastsd.snapshots).toEqual([]);
  expect(lastsd.from).toBe(4);
  expect(lastsd.to).toBe(4);
});

test("merge-add", () => {
  // test merging two diffs that refer to different entities; the resulting
  // merge contains both entities
  const MAX_LENGTH = 2;
  const ip = newDiffBuffer(MAX_LENGTH, 10);

  const A1 = snap({ id: A, xy: 0, color: "red" });
  const B2 = snap({ id: B, xy: 5, color: "blue" });
  const C3 = snap({ id: C, xy: 7, color: "yellow" });

  const sd1 = SD({ from: 0, to: 1, removed: [], snapshots: A1 });
  const sd2 = SD({ from: 1, to: 2, removed: [], snapshots: B2 });
  const sd3 = SD({ from: 2, to: 3, snapshots: C3 });

  ip.push(sd1);
  ip.push(sd2);
  ip.push(sd3); // forces sd1 and sd2 to merge

  const r1 = ip.pull(100);
  r1.snapshots = sortSnapshots(r1.snapshots);
  expect(r1).toMatchObject({
    from: 0,
    to: 2,
    snapshots: sortSnapshots([...A1, ...B2]),
  });

  // another call to interpolator should return sd3 unmodified
  const sd = ip.pull(120);
  expect(sd).toMatchObject(sd3);
});

test("merge-replace", () => {
  // test merging when the newer diff has a more updated version of the same
  // entity. The newer diff must prevail.
  const MAX_LENGTH = 2;
  const ip = newDiffBuffer(MAX_LENGTH, 10);

  const A1 = snap({ id: A, xy: 0, color: "red" });
  const A2 = snap({ id: A, xy: 5, color: "blue" });
  const C3 = snap({ id: C, xy: 7, color: "yellow" });

  const sd1 = SD({ from: 0, to: 1, snapshots: A1 });
  const sd2 = SD({ from: 1, to: 2, snapshots: A2 });
  const sd3 = SD({ from: 2, to: 3, snapshots: C3 });

  ip.push(sd1);
  ip.push(sd2);
  ip.push(sd3); // forces sd1 and sd2 to merge to fit sd3

  const r1 = ip.pull(100);
  expect(r1).toMatchObject(SD({ from: 0, to: 2, snapshots: A2 }));

  const sd = ip.pull(120);
  expect(sd).toMatchObject(sd3);
});

function createMergeRemoveDiffs(): {
  A1: ComponentSnapshot[];
  C3: ComponentSnapshot[];
  sd1: Diff;
  sd2: Diff;
  sd3: Diff;
} {
  const A1 = snap({ id: A, xy: 0, color: "red" });
  const C3 = snap({ id: C, xy: 7, color: "yellow" });

  const sd1 = SD({ from: 0, to: 1, snapshots: A1 });
  const sd2 = SD({
    from: 1,
    to: 2,
    removed: [CID(A, ColorWireType)], // A's color component is removed; position remains
    snapshots: [],
  });
  const sd3 = SD({ from: 2, to: 3, snapshots: C3 });
  return { A1, C3, sd1, sd2, sd3 };
}

test("merge-remove", () => {
  // test merging when the newer diff removes a component (A's color) that was
  // created before. Must cancel previous snapshots of that component and keep
  // a removed entry so the client state catches up.
  const MAX_LENGTH = 2;
  const ip = newDiffBuffer(MAX_LENGTH, 10);

  const { sd1, sd2, sd3 } = createMergeRemoveDiffs();

  ip.push(sd1); // creates A with position and color
  ip.push(sd2); // removes A's color component only
  ip.push(sd3); // creates C; with bucket length 2, forces sd1+sd2 to merge

  const r1 = ip.pull(100);
  r1.removed = r1.removed || [];
  r1.snapshots = r1.snapshots || [];
  expect(r1).toMatchObject({
    from: 0,
    to: 2,
    removed: [CID(A, ColorWireType)],
    snapshots: [makePosComponent(A, 0, 0)],
  });

  expect(ip.pull(120)).toMatchObject(sd3);
});

test("merge-remove-readd", () => {
  // test merging when the newer diff removes a component (A's color) that was
  // created before, then that component reappears. Must cancel the intermediate
  // "removed" entry.
  const MAX_LENGTH = 2;
  const ip = newDiffBuffer(MAX_LENGTH, 10);
  const A4 = snap({ id: A, xy: 0, color: "orange" });

  const { C3, sd1, sd2, sd3 } = createMergeRemoveDiffs();
  const sd4 = SD({ from: 3, to: 4, snapshots: A4 });
  const sd5 = SD({ from: 4, to: 5, snapshots: [] });

  ip.push(sd1);
  ip.push(sd2);
  ip.push(sd3);
  ip.push(sd4);
  ip.push(sd5);
  const r1 = ip.pull(100);

  r1.removed = r1.removed || [];
  r1.snapshots = sortSnapshots(r1.snapshots || []);
  expect(r1).toMatchObject({
    from: 0,
    to: 4,
    removed: [],
    snapshots: sortSnapshots([...C3, ...A4]),
  });

  expect(ip.pull(120)).toMatchObject(sd5);
});

test("Diff.getSnapshot works before and after smap materialization", () => {
  const position = makePosComponent(A, 0, 0);
  const color = makeColorComponent(A, "red");
  const sd = SD({ from: 0, to: 1, snapshots: [position, color] });

  expect(sd.getSnapshot(position.cid)).toBe(position);
  expect(sd.getSnapshot(CID(B, PositionWireType))).toBeUndefined();
  expect(hasMaterializedSnapshotMap(sd)).toBe(false);

  expect(sd.smap.get(color.cid)).toBe(color);
  expect(sd.getSnapshot(color.cid)).toBe(color);
});

test("Diff.upsertSnapshot replaces and appends without materializing smap", () => {
  const original = makePosComponent(A, 0, 0);
  const replacement = makePosComponent(A, 5, 5);
  const added = makeColorComponent(A, "red");
  const sd = SD({ from: 0, to: 1, snapshots: [original] });

  sd.upsertSnapshot(replacement);
  expect(sd.snapshots).toEqual([replacement]);

  sd.upsertSnapshot(added);
  expect(sd.snapshots).toEqual([replacement, added]);
  expect(hasMaterializedSnapshotMap(sd)).toBe(false);
});

test("Diff.upsertSnapshot keeps materialized smap and snapshots in sync", () => {
  const original = makePosComponent(A, 0, 0);
  const replacement = makePosComponent(A, 5, 5);
  const sd = SD({ from: 0, to: 1, snapshots: [original] });

  expect(sd.smap.get(original.cid)).toBe(original);
  sd.upsertSnapshot(replacement);

  expect(sd.smap.get(replacement.cid)).toBe(replacement);
  expect(sd.snapshots).toEqual([replacement]);
});

test("interpolated snapshots carry Position instances as payload", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  const s2 = SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 10, 20)] });

  ip.push(s1);
  ip.push(s2);

  ip.pull(100);
  const sd105 = ip.pull(105);
  const snapshot = sd105.getSnapshot(CID(A, PositionWireType));

  expect(hasMaterializedSnapshotMap(sd105)).toBe(false);
  expect(snapshot?.payload).toBeInstanceOf(Position);
  expect(Pos(sd105, A)).toEqual({ x: 5, y: 10 });
});

test("does not interpolate entities that only exist in a future frame", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  const s2 = SD({ from: 1, to: 2, snapshots: [makePosComponent(B, 10, 20)] });

  ip.push(s1);
  ip.push(s2);

  ip.pull(100);
  const sd105 = ip.pull(105);

  expect(Pos(sd105, B)).toBeUndefined();
});

test("in-place catch-up merge matches a pure merge of the consumed frames", () => {
  // Forces pull() to fold multiple frames in one catch-up pass, exercising the
  // in-place accumulation path, and checks it produces the same result as the
  // pure (copying) merge of those frames.
  const ip = newDiffBuffer(4, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 0, color: "red" }) });
  const s2 = SD({ from: 1, to: 2, snapshots: snap({ id: B, xy: 5, color: "blue" }) });
  const s3 = SD({ from: 2, to: 3, snapshots: snap({ id: C, xy: 7, color: "green" }) });

  ip.push(s1);
  ip.push(s2);
  ip.push(s3);

  ip.pull(100); // consume s1 and initialize server time
  const pulled = ip.pull(140); // consume s2 and s3 in one catch-up pass

  const folded = merge(merge(new Diff(1, 1), s2, false), s3, false);
  expect(sortSnapshots(pulled.snapshots)).toEqual(sortSnapshots(folded.snapshots));
  expect(pulled.removed ?? []).toEqual(folded.removed ?? []);
  expect(pulled.from).toBe(1);
  expect(pulled.to).toBe(3);
});

test("interpolates using a custom component interpolator supplied via config", () => {
  const alphas: number[] = [];
  // A custom interpolator that records the alpha it is called with and snaps to target.
  const snapToTarget: ComponentInterpolator = (_source, target, alpha) => {
    alphas.push(alpha);
    return target;
  };
  const ip = new DiffBuffer(3, 10, decodePosition, [[PositionWireType, snapToTarget]]);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  const s2 = SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 10, 20)] });

  ip.push(s1);
  ip.push(s2);

  ip.pull(100);
  const sd105 = ip.pull(105);

  // The custom interpolator ran (default interpolatePosition would have produced {5,10}).
  expect(alphas.length).toBeGreaterThan(0);
  expect(Pos(sd105, A)).toEqual({ x: 10, y: 20 });
});

test("does not emit interpolated frames for types without a configured interpolator", () => {
  const ip = new DiffBuffer(3, 10, decodePosition, []);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  const s2 = SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 10, 20)] });

  ip.push(s1);
  ip.push(s2);

  ip.pull(100);
  const sd105 = ip.pull(105);

  // With no interpolator registered, the in-between pull produces no fake frame for A.
  expect(Pos(sd105, A)).toBeUndefined();
});

test("reset returns the interpolator to its initial state", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  ip.push(s1);
  ip.pull(100);

  ip.reset();

  expect(ip.version).toBe(-1);
  expect(ip.bucket).toEqual([undefined, undefined, undefined]);
  const empty = ip.pull(200);
  expect(empty).toMatchObject({ from: 0, to: 0, snapshots: [] });
});

// A closing ServerWorld flushes the RPC replies it still owes on a numbered
// "receipt" frame — an empty diff from the client's last acked frame — and
// waits for the ack of that frame before closing the transport. These tests
// pin the wire usage the server now relies on: an empty diff advances the
// acknowledged version, is idempotent under the server's per-tick
// retransmission, and never reads as a full baseline (fromFrame 0), which
// would destroy and rebuild every replicated entity.
test("acknowledges a numbered empty receipt frame the server flushes owed replies on", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 1, 1)] });
  ip.push(s1);
  ip.pull(10);
  expect(ip.version).toBe(1);

  // The server's close-session flush: empty diff, from = the acked frame.
  const receipt = SD({ from: 1, to: 2, snapshots: [] });
  ip.push(receipt);

  expect(ip.version).toBe(2);
  // Applying it is a no-op: no snapshots, no removals.
  const applied = ip.pull(20);
  expect(applied.snapshots).toEqual([]);
  expect(applied.removed).toBeUndefined();
});

test("accepts a receipt frame as the first frame into an empty buffer", () => {
  const ip = newDiffBuffer(3, 10);

  // A client that received nothing yet can still be flushed at: its ack
  // reports version 0 and the server numbers the receipt from frame 1.
  const receipt = SD({ from: 1, to: 1, snapshots: [] });
  ip.push(receipt);

  expect(ip.version).toBe(1);
});

test("deduplicates the receipt frame when the server retransmits it during the linger", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 5, 5)] });
  ip.push(s1);
  ip.pull(10);
  expect(ip.version).toBe(1);

  // The server sends the same numbered frame on every linger tick until the
  // ack arrives; the unordered channel may also duplicate the datagram.
  const first = SD({ from: 1, to: 2, snapshots: [] });
  ip.push(first);
  ip.push(first);
  ip.push(first);

  expect(ip.version).toBe(2);
  const applied = ip.pull(20);
  expect(applied.snapshots).toEqual([]);
});

test("accepts a receipt frame sent behind a lagging ack", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 3, snapshots: [makePosComponent(A, 2, 2)] });
  ip.push(s1);

  // The server's session ack still reads 0 (the client's ack was lost), but
  // the client received frame 3; fromFrame 1 stays within its version range.
  const receipt = SD({ from: 1, to: 4, snapshots: [] });
  expect(() => ip.push(receipt)).not.toThrow();

  expect(ip.version).toBe(4);
});

// The unordered channel can deliver a datagram long after its successors. Once pull() has consumed
// the buffered frames the bucket is empty, but `version` still names the newest frame received, and
// a straggler for an older frame must not roll it back: the server has seen the newer frame acked,
// so its next delta starts there, and would then look as if it started past the client.
test("discards a stale diff that arrives after the bucket drained, and takes the next real delta", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 4, snapshots: [makePosComponent(A, 4, 4)] }));
  ip.pull(10);
  expect(ip.version).toBe(4);
  expect(ip.bucket).toEqual([undefined, undefined, undefined]);

  // A straggler: frame 2, from frame 1.
  ip.push(SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 2, 2)] }));

  expect(ip.version).toBe(4);
  expect(ip.bucket).toEqual([undefined, undefined, undefined]);
  expect(ip.pull(20).snapshots).toEqual([]);

  // The delta the server sends next starts at the frame it last saw acked, which is frame 4.
  const next = SD({ from: 4, to: 5, snapshots: [makePosComponent(A, 5, 5)] });
  expect(() => ip.push(next)).not.toThrow();
  expect(ip.version).toBe(5);
  expect(Pos(ip.pull(100), A)).toEqual({ x: 5, y: 5 });
});

test("discards a duplicate of the newest frame after the bucket drained", () => {
  const ip = newDiffBuffer(3, 10);
  const frame = SD({ from: 0, to: 4, snapshots: [makePosComponent(A, 4, 4)] });
  ip.push(frame);
  ip.pull(10);

  ip.push(frame);

  expect(ip.version).toBe(4);
  expect(ip.bucket[0]).toBeUndefined();
});

test("still rejects a diff that starts past the acked frame after the bucket drained", () => {
  const ip = newDiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 4, snapshots: [makePosComponent(A, 4, 4)] }));
  ip.pull(10);

  expect(() => ip.push(SD({ from: 7, to: 8, snapshots: [] }))).toThrow(
    "diff starts at frame 7, past this client's frame 4"
  );
  expect(ip.version).toBe(4);
});

test("takes any diff as the starting point after reset, whatever frame it names", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 40, snapshots: [makePosComponent(A, 40, 40)] }));
  ip.pull(10);
  ip.reset();
  expect(ip.version).toBe(-1);

  // A new connection to a server whose frame counter restarted.
  ip.push(SD({ from: 0, to: 3, snapshots: [makePosComponent(A, 3, 3)] }));

  expect(ip.version).toBe(3);
  expect(Pos(ip.pull(100), A)).toEqual({ x: 3, y: 3 });
});

// `renderFrame` is the fractional server frame the buffer renders. These tests move A to
// x = 10 f in frame f, so wherever A is rendered, x / 10 is the server frame on screen.
function movingA(from: number, to: number): Diff {
  return SD({ from, to, snapshots: [makePosComponent(A, 10 * to, 0)] });
}

test("renderFrame is 0 until a frame is applied, holds at the newest frame when the buffer runs dry, and returns to 0 on reset", () => {
  const ip = newDiffBuffer(3, 10);
  expect(ip.renderFrame).toBe(0);
  ip.pull(100);
  expect(ip.renderFrame).toBe(0);

  ip.push(movingA(0, 7));
  ip.push(movingA(7, 8));
  // Received, but the buffer waits out the refill delay an empty pull started: nothing applied yet.
  ip.pull(110);
  expect(ip.renderFrame).toBe(0);
  ip.pull(130);
  expect(ip.renderFrame).toBe(7);
  ip.pull(135);
  expect(ip.renderFrame).toBeCloseTo(7.5, 9);
  ip.pull(140);
  expect(ip.renderFrame).toBe(8);

  // Dry: it never runs past the newest frame received, however much time passes.
  ip.pull(150);
  ip.pull(500);
  expect(ip.renderFrame).toBe(8);

  ip.reset();
  expect(ip.renderFrame).toBe(0);
  // A new stream, from a server whose frame counter restarted, can start lower.
  ip.push(movingA(0, 2));
  ip.pull(600);
  expect(ip.renderFrame).toBe(2);
});

test("renderFrame is the point the interpolators sample, never decreases and never passes the newest frame received", () => {
  const interval = 10;
  const samples: { alpha: number; from: number; to: number }[] = [];
  const recordingInterpolator: ComponentInterpolator = (source, target, alpha) => {
    samples.push({ alpha, from: (source as Position).x / 10, to: (target as Position).x / 10 });
    return interpolatePosition(source, target, alpha);
  };
  const ip = new DiffBuffer(3, interval, decodePosition, [
    [PositionWireType, recordingInterpolator],
  ]);

  // Frames arrive 25-30 ms after the server sends them. Frame 50 is lost and arrives merged into
  // frame 51's diff; frames 70-79 are held up by a stall and arrive together with frame 80.
  const arrivals = new Map<number, Diff[]>();
  for (let f = 1; f <= 100; f++) {
    if (f === 50) {
      continue;
    }
    const arriveAt = f >= 70 && f < 80 ? 80 * interval + 25 : f * interval + 25 + ((f * 37) % 6);
    arrivals.set(arriveAt, [...(arrivals.get(arriveAt) ?? []), movingA(f === 51 ? 49 : f - 1, f)]);
  }

  let previous = 0;
  let segmentStarts = 0;
  // Render every 7 ms, off the server's 10 ms grid.
  for (let now = 0; now <= 1500; now++) {
    arrivals.get(now)?.forEach((diff) => ip.push(diff));
    if (now % 7 !== 3) {
      continue;
    }
    samples.length = 0;
    const rendered = Pos(ip.pull(now), A);

    expect(ip.renderFrame).toBeGreaterThanOrEqual(previous);
    // `version` is -1 until something is received, and renderFrame 0.
    expect(ip.renderFrame).toBeLessThanOrEqual(Math.max(ip.version, 0));
    if (rendered !== undefined) {
      expect(rendered.x / 10).toBeCloseTo(ip.renderFrame, 9);
    }
    for (const sample of samples) {
      // The interpolators blend from the point last rendered toward the next frame, with the same
      // alpha. From an applied frame N toward N + 1 that point is N + alpha.
      expect(ip.renderFrame).toBeCloseTo(sample.from + (sample.to - sample.from) * sample.alpha, 9);
      if (Number.isInteger(sample.from) && sample.to === sample.from + 1) {
        expect(ip.renderFrame).toBeCloseTo(sample.from + sample.alpha, 9);
        segmentStarts++;
      }
    }
    previous = ip.renderFrame;
  }

  expect(previous).toBe(100);
  expect(segmentStarts).toBeGreaterThan(20);
});

/** Pull until the buffer is dry, and return everything it handed out as one diff. */
function drain(ip: DiffBuffer): Diff {
  let all: Diff | undefined;
  for (let i = 0; i < 2 * ip.bucket.length + 2; i++) {
    all = merge(all, ip.pull(1000 + 10 * i), false);
  }
  return all!;
}

// An optimistic diff is built by a server that presumes the client already holds the frames before it,
// because it sent them in earlier frames that have not been acked yet. When one of those frames was
// lost the diff starts past the newest frame the client has. The buffer holds it until the missing
// frames arrive, applies it then, and tells the client to report a gap meanwhile.
test("holds an optimistic diff that starts past the newest frame instead of rejecting it", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [makePosComponent(A, 12, 12)] }));

  const optimistic = SD({ from: 14, to: 16, snapshots: [makePosComponent(B, 16, 16)] });
  expect(() => ip.push(optimistic, true)).not.toThrow();

  // Held, not buffered: nothing to ack and nothing to apply yet.
  expect(ip.version).toBe(12);
  expect(Pos(drain(ip), B)).toBeUndefined();
  expect(ip.takeGap()).toBe(true);
});

test("reports the gap once per detection", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [makePosComponent(A, 12, 12)] }));
  expect(ip.takeGap()).toBe(false);

  ip.push(SD({ from: 14, to: 16, snapshots: [] }), true);
  expect(ip.takeGap()).toBe(true);
  expect(ip.takeGap()).toBe(false);

  // Another optimistic diff the client cannot use is another detection.
  ip.push(SD({ from: 15, to: 17, snapshots: [] }), true);
  expect(ip.takeGap()).toBe(true);
  expect(ip.takeGap()).toBe(false);
});

test("applies a held diff as soon as the frames before it arrive", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [makePosComponent(A, 12, 12)] }));
  ip.push(SD({ from: 14, to: 16, snapshots: [makePosComponent(B, 16, 16)] }), true);

  // Frame 14, which the held diff was built on, arrives late.
  ip.push(SD({ from: 12, to: 14, snapshots: [makePosComponent(A, 14, 14)] }));

  expect(ip.version).toBe(16);
  const state = drain(ip);
  expect(Pos(state, A)).toEqual({ x: 14, y: 14 });
  expect(Pos(state, B)).toEqual({ x: 16, y: 16 });
});

test("has no gap to report once the frames before the held diff arrived, even if it was never asked", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [] }));
  ip.push(SD({ from: 14, to: 16, snapshots: [] }), true);

  ip.push(SD({ from: 12, to: 14, snapshots: [] }));

  expect(ip.takeGap()).toBe(false);
});

test("applies held diffs in order, each one bringing the next within reach", () => {
  const ip = new DiffBuffer(4, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [makePosComponent(A, 12, 12)] }));
  // Two frames arrive ahead of the one they are built on, the later one first.
  ip.push(SD({ from: 16, to: 18, snapshots: [makePosComponent(C, 18, 18)] }), true);
  ip.push(SD({ from: 14, to: 16, snapshots: [makePosComponent(B, 16, 16)] }), true);
  expect(ip.version).toBe(12);

  ip.push(SD({ from: 12, to: 14, snapshots: [makePosComponent(A, 14, 14)] }));

  expect(ip.version).toBe(18);
  const state = drain(ip);
  expect(Pos(state, A)).toEqual({ x: 14, y: 14 });
  expect(Pos(state, B)).toEqual({ x: 16, y: 16 });
  expect(Pos(state, C)).toEqual({ x: 18, y: 18 });
});

test("holds and releases a diff after the bucket drained", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [makePosComponent(A, 12, 12)] }));
  ip.pull(1000);
  expect(ip.bucket).toEqual([undefined, undefined, undefined]);

  ip.push(SD({ from: 14, to: 16, snapshots: [makePosComponent(B, 16, 16)] }), true);
  expect(ip.version).toBe(12);
  ip.push(SD({ from: 12, to: 14, snapshots: [makePosComponent(A, 14, 14)] }));

  expect(ip.version).toBe(16);
  expect(Pos(drain(ip), B)).toEqual({ x: 16, y: 16 });
});

test("drops a held diff once a later frame has passed it, without applying it", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [makePosComponent(A, 12, 12)] }));
  ip.push(SD({ from: 14, to: 16, snapshots: [makePosComponent(B, 16, 16)] }), true);

  // The server falls back to a delta from the acked frame, which covers everything the held diff did.
  ip.push(SD({ from: 12, to: 20, snapshots: [makePosComponent(A, 20, 20)] }));

  expect(ip.version).toBe(20);
  const state = drain(ip);
  expect(Pos(state, A)).toEqual({ x: 20, y: 20 });
  expect(Pos(state, B)).toBeUndefined();
  expect(ip.takeGap()).toBe(false);
});

test("holds at most MAX_HELD_DIFFS diffs and drops the oldest to make room", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 10, snapshots: [] }));
  // One more than fits: diff k starts where diff k - 1 ends, from frame 20 on.
  for (let k = 0; k <= MAX_HELD_DIFFS; k++) {
    ip.push(SD({ from: 20 + k, to: 21 + k, snapshots: [] }), true);
  }

  // Frame 20 reaches the first held diff, which would chain through every other if it were still held.
  ip.push(SD({ from: 10, to: 20, snapshots: [] }));
  expect(ip.version).toBe(20);

  // The oldest was dropped, so the rest wait for the frame it covered (20 to 21).
  ip.push(SD({ from: 20, to: 21, snapshots: [] }));
  expect(ip.version).toBe(21 + MAX_HELD_DIFFS);
});

test("keeps rejecting a diff that starts past the newest frame and is not optimistic, even while it holds others", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [] }));
  ip.push(SD({ from: 14, to: 16, snapshots: [] }), true);

  expect(() => ip.push(SD({ from: 14, to: 17, snapshots: [] }))).toThrow(
    "diff starts at frame 14, past this client's frame 12"
  );
  expect(() => ip.push(SD({ from: 14, to: 17, snapshots: [] }), false)).toThrow(
    "diff starts at frame 14, past this client's frame 12"
  );
  expect(ip.version).toBe(12);
});

test("an optimistic diff that starts within the newest frame is an ordinary diff", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [makePosComponent(A, 12, 12)] }));

  ip.push(SD({ from: 11, to: 14, snapshots: [makePosComponent(A, 14, 14)] }), true);

  expect(ip.version).toBe(14);
  expect(ip.takeGap()).toBe(false);
  expect(Pos(drain(ip), A)).toEqual({ x: 14, y: 14 });
});

test("reset forgets the held diffs and the gap", () => {
  const ip = new DiffBuffer(3, 10);
  ip.push(SD({ from: 0, to: 12, snapshots: [] }));
  ip.push(SD({ from: 14, to: 16, snapshots: [makePosComponent(B, 16, 16)] }), true);

  ip.reset();

  expect(ip.takeGap()).toBe(false);
  // A new stream starts wherever it likes, and the old held diff is not released into it.
  ip.push(SD({ from: 0, to: 14, snapshots: [makePosComponent(A, 14, 14)] }));
  expect(ip.version).toBe(14);
  expect(Pos(drain(ip), B)).toBeUndefined();
});

// A diff means: its resets first, then its snapshots, then the removals of single components.
// Within it, a snapshot of an eid that the same diff resets belongs to the entity that took the eid
// after the removal. A reset carries the server frame of the removal, and a delta repeats it for as
// long as the ack that would end it is in flight, so the frame is what tells a repeat from a new
// removal: merge keeps the newest frame of each eid, and drops what an older entity left only for a
// reset that is newer than the one the other diff holds. DiffBuffer.pull hands out the resets the
// world has not applied, and must not blend the new entity from the old one.

type Resets = Array<[EID, number]>;

function resetsOf(diff: Diff): Resets {
  return [...(diff.resets ?? [])].sort((x, y) => x[0] - y[0]);
}

function removedOf(diff: Diff): number[] {
  return [...(diff.removed ?? [])].sort((x, y) => x - y);
}

function snapshotIds(diff: Diff): number[] {
  return diff.snapshots.map((s) => s.cid).sort((x, y) => x - y);
}

function sorted(...ids: number[]): number[] {
  return ids.sort((x, y) => x - y);
}

interface MergeCase {
  name: string;
  /** The older diff. */
  a: () => Diff;
  /** The newer diff. */
  b: () => Diff;
  resets: Resets;
  removed: number[];
  snapshots: number[];
  /** The Position of A in the merged diff, when it should have one. */
  position?: { x: number; y: number };
}

const resetMergeCases: MergeCase[] = [
  {
    name: "a reset in the newer diff drops the older snapshots of that entity, and only of that entity",
    a: () =>
      SD({
        from: 0,
        to: 1,
        snapshots: [
          ...snap({ id: A, xy: 1, color: "red" }),
          ...snap({ id: B, xy: 2, color: "blue" }),
        ],
      }),
    b: () => SD({ from: 1, to: 2, resets: [[A, 2]], snapshots: [] }),
    resets: [[A, 2]],
    removed: [],
    snapshots: sorted(CID(B, PositionWireType), CID(B, ColorWireType)),
  },
  {
    name: "a reset in the newer diff drops the older snapshots and keeps the newer ones of the same eid",
    a: () => SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) }),
    b: () => SD({ from: 1, to: 2, resets: [[A, 2]], snapshots: [makePosComponent(A, 9, 9)] }),
    resets: [[A, 2]],
    removed: [],
    snapshots: [CID(A, PositionWireType)],
    position: { x: 9, y: 9 },
  },
  {
    name: "a reset in the older diff stays when the newer one snapshots the eid",
    a: () => SD({ from: 0, to: 1, resets: [[A, 1]], snapshots: [] }),
    b: () => SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 5, 5)] }),
    resets: [[A, 1]],
    removed: [],
    snapshots: [CID(A, PositionWireType)],
    position: { x: 5, y: 5 },
  },
  {
    name: "a reset and snapshots in the older diff stay, merged with the newer snapshots of the eid",
    a: () =>
      SD({
        from: 0,
        to: 1,
        resets: [[A, 1]],
        snapshots: snap({ id: A, xy: 1, color: "orange" }),
      }),
    b: () => SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 7, 7)] }),
    resets: [[A, 1]],
    removed: [],
    snapshots: sorted(CID(A, PositionWireType), CID(A, ColorWireType)),
    position: { x: 7, y: 7 },
  },
  {
    name: "a newer reset of the same eid replaces the older reset's frame and drops its snapshots",
    a: () =>
      SD({
        from: 0,
        to: 1,
        resets: [[A, 1]],
        snapshots: snap({ id: A, xy: 1, color: "red" }),
      }),
    b: () =>
      SD({
        from: 1,
        to: 3,
        resets: [[A, 3]],
        snapshots: [makeColorComponent(A, "green")],
      }),
    resets: [[A, 3]],
    removed: [],
    snapshots: [CID(A, ColorWireType)],
  },
  {
    name: "the same reset repeated by an overlapping delta keeps what the older diff holds, merged with the newer's",
    a: () =>
      SD({
        from: 0,
        to: 3,
        resets: [[A, 2]],
        snapshots: [makePosComponent(A, 1, 1), makeColorComponent(A, "red")],
      }),
    b: () =>
      SD({
        from: 0,
        to: 4,
        resets: [[A, 2]],
        snapshots: [makePosComponent(A, 5, 5)],
      }),
    resets: [[A, 2]],
    removed: [],
    snapshots: sorted(CID(A, PositionWireType), CID(A, ColorWireType)),
    position: { x: 5, y: 5 },
  },
  {
    name: "a repeated reset keeps the removal that follows it in the overlapping delta, and deletes the snapshot it removes",
    a: () =>
      SD({
        from: 0,
        to: 3,
        resets: [[A, 2]],
        snapshots: [makePosComponent(A, 1, 1), makeColorComponent(A, "red")],
      }),
    b: () =>
      SD({
        from: 0,
        to: 4,
        resets: [[A, 2]],
        removed: [CID(A, ColorWireType)],
        snapshots: [makePosComponent(A, 5, 5)],
      }),
    resets: [[A, 2]],
    removed: [CID(A, ColorWireType)],
    snapshots: [CID(A, PositionWireType)],
    position: { x: 5, y: 5 },
  },
  {
    name: "a reset in the newer diff that is older than the older diff's keeps the older diff's frame and snapshots",
    a: () => SD({ from: 0, to: 5, resets: [[A, 5]], snapshots: [makePosComponent(A, 2, 2)] }),
    b: () => SD({ from: 0, to: 6, resets: [[A, 3]], snapshots: [makeColorComponent(A, "blue")] }),
    resets: [[A, 5]],
    removed: [],
    snapshots: sorted(CID(A, PositionWireType), CID(A, ColorWireType)),
    position: { x: 2, y: 2 },
  },
  {
    name: "resets of different eids in the two diffs are both kept, with their own frames",
    a: () => SD({ from: 0, to: 1, resets: [[A, 1]], snapshots: [] }),
    b: () => SD({ from: 1, to: 2, resets: [[B, 2]], snapshots: [] }),
    resets: [
      [A, 1],
      [B, 2],
    ],
    removed: [],
    snapshots: [],
  },
  {
    name: "a reset in the newer diff drops the older removals of single components of that entity",
    a: () =>
      SD({
        from: 0,
        to: 1,
        removed: [CID(A, ColorWireType), CID(B, ColorWireType)],
        snapshots: [],
      }),
    b: () => SD({ from: 1, to: 2, resets: [[A, 2]], snapshots: [] }),
    resets: [[A, 2]],
    removed: [CID(B, ColorWireType)],
    snapshots: [],
  },
  {
    name: "a reset in the newer diff keeps that diff's own removals of single components",
    a: () => SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) }),
    b: () =>
      SD({
        from: 1,
        to: 2,
        resets: [[A, 2]],
        removed: [CID(A, ColorWireType)],
        snapshots: [makePosComponent(A, 3, 3)],
      }),
    resets: [[A, 2]],
    removed: [CID(A, ColorWireType)],
    snapshots: [CID(A, PositionWireType)],
    position: { x: 3, y: 3 },
  },
  {
    name: "a newer removal of a component the reset entity was given after the reset stays, next to the reset",
    a: () =>
      SD({
        from: 0,
        to: 1,
        resets: [[A, 1]],
        snapshots: snap({ id: A, xy: 1, color: "red" }),
      }),
    b: () => SD({ from: 1, to: 2, removed: [CID(A, ColorWireType)], snapshots: [] }),
    resets: [[A, 1]],
    removed: [CID(A, ColorWireType)],
    snapshots: [CID(A, PositionWireType)],
    position: { x: 1, y: 1 },
  },
  {
    name: "a newer snapshot of a component the older diff removed still un-deletes it",
    a: () => SD({ from: 0, to: 1, removed: [CID(A, ColorWireType)], snapshots: [] }),
    b: () => SD({ from: 1, to: 2, snapshots: [makeColorComponent(A, "teal")] }),
    resets: [],
    removed: [],
    snapshots: [CID(A, ColorWireType)],
  },
  {
    name: "a newer removal of a single component deletes the older snapshot",
    a: () => SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) }),
    b: () => SD({ from: 1, to: 2, removed: [CID(A, ColorWireType)], snapshots: [] }),
    resets: [],
    removed: [CID(A, ColorWireType)],
    snapshots: [CID(A, PositionWireType)],
    position: { x: 1, y: 1 },
  },
];

test.each(resetMergeCases)("merge: $name", (c) => {
  const a = c.a();
  const b = c.b();

  const merged = merge(a, b);

  expect(resetsOf(merged)).toEqual(c.resets);
  expect(removedOf(merged)).toEqual(c.removed);
  expect(snapshotIds(merged)).toEqual(c.snapshots);
  if (c.position) {
    expect(Pos(merged, A)).toEqual(c.position);
  }
  expect([merged.from, merged.to]).toEqual([a.from, b.to]);
  // The inputs are not touched.
  expect(resetsOf(a)).toEqual(resetsOf(c.a()));
  expect(removedOf(a)).toEqual(removedOf(c.a()));
  expect(snapshotIds(a)).toEqual(snapshotIds(c.a()));
  expect(resetsOf(b)).toEqual(resetsOf(c.b()));
  expect(removedOf(b)).toEqual(removedOf(c.b()));
  expect(snapshotIds(b)).toEqual(snapshotIds(c.b()));
});

test.each(resetMergeCases)("merge in place gives the same result: $name", (c) => {
  const pure = merge(c.a(), c.b(), false);
  const folded = merge(c.a(), c.b(), false, true);

  expect(resetsOf(folded)).toEqual(resetsOf(pure));
  expect(removedOf(folded)).toEqual(removedOf(pure));
  expect(snapshotIds(folded)).toEqual(snapshotIds(pure));
});

test("merge gives the result resets of its own, so the diffs it merged keep theirs", () => {
  const withResets = SD({ from: 0, to: 1, resets: [[A, 1]], snapshots: [] });
  const without = SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 5, 5)] });
  const newer = SD({ from: 1, to: 2, resets: [[B, 2]], snapshots: [] });

  merge(withResets, without)!.resets!.set(C, 9);
  merge(withResets, newer)!.resets!.set(C, 9);
  merge(without, newer)!.resets!.set(C, 9);

  expect(resetsOf(withResets)).toEqual([[A, 1]]);
  expect(resetsOf(newer)).toEqual([[B, 2]]);
  expect(withResets.resets).toBeDefined();
  expect(without.resets).toBeUndefined();
});

test("a diff that resets nothing holds no resets, and merging two of them keeps it that way", () => {
  const a = SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) });
  const b = SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 5, 5)] });

  expect(a.resets).toBeUndefined();
  expect(merge(a, b).resets).toBeUndefined();
  expect(merge(a, b, false, true).resets).toBeUndefined();
});

test("a reset of an eid the older diff never held is kept for the newer diff's snapshots", () => {
  const a = SD({ from: 0, to: 1, snapshots: snap({ id: B, xy: 1, color: "red" }) });
  const b = SD({ from: 1, to: 2, resets: [[A, 2]], snapshots: [makePosComponent(A, 2, 2)] });

  const merged = merge(a, b);

  expect(resetsOf(merged)).toEqual([[A, 2]]);
  expect(snapshotIds(merged)).toEqual(
    sorted(CID(A, PositionWireType), CID(B, PositionWireType), CID(B, ColorWireType))
  );
});

test("pull applies an entity's reset and the snapshots that reuse its eid in one diff", () => {
  const ip = newDiffBuffer(4, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) });
  const s2 = SD({ from: 1, to: 2, resets: [[A, 2]], snapshots: [] });
  const s3 = SD({ from: 2, to: 3, snapshots: [makePosComponent(A, 40, 40)] });

  ip.push(s1);
  ip.push(s2);
  ip.push(s3);

  ip.pull(100); // consumes s1
  const pulled = ip.pull(140); // consumes s2 and s3 in one catch-up pass

  expect(resetsOf(pulled)).toEqual([[A, 2]]);
  expect(snapshotIds(pulled)).toEqual([CID(A, PositionWireType)]);
  expect(Pos(pulled, A)).toEqual({ x: 40, y: 40 });
});

test("pull does not blend an entity from the one whose eid it replaces", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  const s2 = SD({
    from: 1,
    to: 2,
    resets: [[A, 2]],
    snapshots: [makePosComponent(A, 100, 100)],
  });
  ip.push(s1);
  ip.push(s2);

  ip.pull(100); // renders s1, and starts blending toward s2
  const midway = ip.pull(105);

  // Halfway to s2, the old entity stays where it was: the new one is not drawn between the two.
  expect(Pos(midway, A)).toBeUndefined();
  expect(midway.removed).toBeUndefined();
  expect(midway.resets).toBeUndefined();

  const applied = ip.pull(110);

  expect(resetsOf(applied)).toEqual([[A, 2]]);
  expect(Pos(applied, A)).toEqual({ x: 100, y: 100 });
});

test("pull keeps blending the new entity from its own state, not the replaced one's", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  const s2 = SD({
    from: 1,
    to: 2,
    resets: [[A, 2]],
    snapshots: [makePosComponent(A, 100, 100)],
  });
  const s3 = SD({ from: 2, to: 3, snapshots: [makePosComponent(A, 200, 200)] });
  ip.push(s1);
  ip.push(s2);
  ip.push(s3);

  ip.pull(100);
  ip.pull(110); // applies s2: the new entity at (100, 100), blending toward s3
  const midway = ip.pull(115);

  expect(Pos(midway, A)).toEqual({ x: 150, y: 150 });
});

test("pull does not blend a component the new entity lacks from the replaced entity's value", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  // The new entity has a color but no position yet.
  const s2 = SD({
    from: 1,
    to: 2,
    resets: [[A, 2]],
    snapshots: [makeColorComponent(A, "red")],
  });
  const s3 = SD({ from: 2, to: 3, snapshots: [makePosComponent(A, 100, 100)] });
  ip.push(s1);
  ip.push(s2);
  ip.push(s3);

  ip.pull(100);
  const applied = ip.pull(110); // applies s2, blending toward s3

  expect(resetsOf(applied)).toEqual([[A, 2]]);
  // There is nothing of the new entity's to blend from, so the position waits for s3.
  expect(Pos(applied, A)).toBeUndefined();
  expect(Pos(ip.pull(120), A)).toEqual({ x: 100, y: 100 });
});

test("pull hands out a reset newer than the state it starts from, and drops its repeat", () => {
  const ip = newDiffBuffer(4, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) });
  // Frame 2 resets A. The delta for frame 3 starts from an ack before it, so it holds the reset
  // again, and the world holds frame 2 by the time it is pulled.
  const s2 = SD({ from: 1, to: 2, resets: [[A, 2]], snapshots: [makePosComponent(A, 20, 20)] });
  const s3 = SD({ from: 1, to: 3, resets: [[A, 2]], snapshots: [makePosComponent(A, 30, 30)] });
  ip.push(s1);
  ip.push(s2);
  ip.push(s3);

  ip.pull(100);
  const first = ip.pull(110);
  const second = ip.pull(120);

  expect(resetsOf(first)).toEqual([[A, 2]]);
  expect(Pos(first, A)).toEqual({ x: 20, y: 20 });
  expect(second.resets).toBeUndefined();
  expect(Pos(second, A)).toEqual({ x: 30, y: 30 });
});

test("pull applies a repeated reset once, when the repeats are pulled in one go", () => {
  const ip = newDiffBuffer(4, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) });
  const s2 = SD({ from: 1, to: 2, resets: [[A, 2]], snapshots: [makePosComponent(A, 20, 20)] });
  const s3 = SD({ from: 1, to: 3, resets: [[A, 2]], snapshots: [makePosComponent(A, 30, 30)] });
  ip.push(s1);
  ip.push(s2);
  ip.push(s3);

  ip.pull(100);
  const pulled = ip.pull(130); // catches up through s2 and s3 in one pass

  expect(resetsOf(pulled)).toEqual([[A, 2]]);
  expect(Pos(pulled, A)).toEqual({ x: 30, y: 30 });
});

test("pull ends with the newest of two resets of one eid, whatever frame the world holds", () => {
  const start = (): DiffBuffer => {
    const ip = newDiffBuffer(4, 10);
    ip.push(SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) }));
    return ip;
  };
  // A is replaced at frame 2, and its replacement is replaced at frame 3.
  const toB = SD({ from: 1, to: 2, resets: [[A, 2]], snapshots: [makePosComponent(A, 20, 20)] });
  const toC = SD({ from: 1, to: 3, resets: [[A, 3]], snapshots: [makeColorComponent(A, "C")] });

  // The world holds frame 1, before both: it applies the newer reset, and nothing of B.
  const before = start();
  before.push(toB);
  before.push(toC);
  before.pull(100);
  const fromBefore = before.pull(130);
  expect(resetsOf(fromBefore)).toEqual([[A, 3]]);
  expect(snapshotIds(fromBefore)).toEqual([CID(A, ColorWireType)]);

  // The world holds frame 2, after the first: only the newer reset is new.
  const between = start();
  between.push(toB);
  between.pull(100);
  between.pull(110);
  between.push(toC);
  const fromBetween = between.pull(120);
  expect(resetsOf(fromBetween)).toEqual([[A, 3]]);
  expect(snapshotIds(fromBetween)).toEqual([CID(A, ColorWireType)]);

  // The world holds frame 3, after both: neither is new, and C is updated in place.
  const after = start();
  after.push(toB);
  after.push(toC);
  after.pull(100);
  after.pull(130);
  after.push(
    SD({
      from: 1,
      to: 4,
      resets: [[A, 3]],
      snapshots: [makeColorComponent(A, "C"), makePosComponent(A, 6, 6)],
    })
  );
  const fromAfter = after.pull(140);
  expect(fromAfter.resets).toBeUndefined();
  expect(snapshotIds(fromAfter)).toEqual(sorted(CID(A, PositionWireType), CID(A, ColorWireType)));
});

test("pull keeps blending an entity across a reset the world has applied already", () => {
  const ip = newDiffBuffer(3, 10);
  const s1 = SD({ from: 0, to: 1, resets: [[A, 1]], snapshots: [makePosComponent(A, 0, 0)] });
  // An overlapping delta, from before frame 1: it repeats the reset at frame 1.
  const s2 = SD({ from: 0, to: 2, resets: [[A, 1]], snapshots: [makePosComponent(A, 100, 100)] });
  ip.push(s1);
  ip.push(s2);

  ip.pull(100); // renders s1, and starts blending toward s2
  const midway = ip.pull(105);

  // The reset is not new, so the entity moves toward s2 as any entity does.
  expect(Pos(midway, A)).toEqual({ x: 50, y: 50 });

  const applied = ip.pull(110);

  expect(applied.resets).toBeUndefined();
  expect(Pos(applied, A)).toEqual({ x: 100, y: 100 });
});

test("pull passes on the removals that follow a reset it skips", () => {
  const ip = newDiffBuffer(4, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: snap({ id: A, xy: 1, color: "red" }) });
  const s2 = SD({
    from: 1,
    to: 2,
    resets: [[A, 2]],
    snapshots: snap({ id: A, xy: 2, color: "blue" }),
  });
  // An overlapping delta, from before the reset: the entity lost its color after the reset.
  const s3 = SD({
    from: 1,
    to: 3,
    resets: [[A, 2]],
    removed: [CID(A, ColorWireType)],
    snapshots: [makePosComponent(A, 3, 3)],
  });
  ip.push(s1);
  ip.push(s2);
  ip.push(s3);

  ip.pull(100);
  ip.pull(110);
  const third = ip.pull(120);

  expect(third.resets).toBeUndefined();
  expect(removedOf(third)).toEqual([CID(A, ColorWireType)]);
  expect(Pos(third, A)).toEqual({ x: 3, y: 3 });
});
