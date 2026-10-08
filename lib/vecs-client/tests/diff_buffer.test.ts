import { expect, test } from "vitest";
import { cid_pack } from "@vworlds/vecs-protocol";
import type { EID } from "@vworlds/vecs";
import { Encoder, Decoder } from "@vworlds/vecs-wire";
import {
  ComponentSnapshot,
  Diff,
  DiffBuffer,
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
  snapshots: ComponentSnapshot[];
}): Diff {
  const d = new Diff(p.from, p.to, p.removed);
  d.snapshots = p.snapshots;
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
