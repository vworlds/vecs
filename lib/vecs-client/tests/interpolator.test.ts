import { expect, test } from "vitest";
import { cid_pack } from "@vworlds/vecs-protocol";
import { Encoder, Decoder } from "@vworlds/vecs-wire";
import { ComponentSnapshot, Diff, Interpolator, merge } from "../src/interpolator.js";

const PositionType = 1;
const ColorType = 6;

class Position {
  public x = 0;
  public y = 0;
}

function CID(eid: number, type: number): number {
  return cid_pack(eid, type);
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

function makePosComponent(eid: number, x: number, y: number): ComponentSnapshot {
  return new ComponentSnapshot(eid, PositionType, encodePos(x, y));
}

function makeColorComponent(eid: number, color: string): ComponentSnapshot {
  return new ComponentSnapshot(eid, ColorType, encodeColor(color));
}

// test snapshot generator: returns Position + Color components for one entity
function snap({ id, xy, color }: { id: number; xy: number; color: string }): ComponentSnapshot[] {
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

function Color(sd: Diff, id: number): string | undefined {
  const s = sd.smap.get(CID(id, ColorType));
  if (!s) {
    return undefined;
  }
  if (!(s.payload instanceof Uint8Array)) {
    throw new Error("Color payload must be encoded bytes");
  }
  return new Decoder(s.payload).read_string();
}

function Pos(sd: Diff, id: number): { x: number; y: number } | undefined {
  const s = sd.smap.get(CID(id, PositionType));
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

function newInterpolator(maxLength: number, serverTickInterval: number): Interpolator {
  return new Interpolator(maxLength, serverTickInterval, decodePosition);
}

const A = 1;
const B = 2;
const C = 3;
const D = 4;

test("reorder", () => {
  const MAX_LENGTH = 4;
  let ip = newInterpolator(MAX_LENGTH, 10);
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
  ip = newInterpolator(MAX_LENGTH, 10);
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
  const ip = newInterpolator(MAX_LENGTH, 10);

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
  const ip = newInterpolator(MAX_LENGTH, 10);

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
  const ip = newInterpolator(MAX_LENGTH, 10);

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
    removed: [CID(A, ColorType)], // A's color component is removed; position remains
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
  const ip = newInterpolator(MAX_LENGTH, 10);

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
    removed: [CID(A, ColorType)],
    snapshots: [makePosComponent(A, 0, 0)],
  });

  expect(ip.pull(120)).toMatchObject(sd3);
});

test("merge-remove-readd", () => {
  // test merging when the newer diff removes a component (A's color) that was
  // created before, then that component reappears. Must cancel the intermediate
  // "removed" entry.
  const MAX_LENGTH = 2;
  const ip = newInterpolator(MAX_LENGTH, 10);
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

test("interpolated snapshots carry Position instances as payload", () => {
  const ip = newInterpolator(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  const s2 = SD({ from: 1, to: 2, snapshots: [makePosComponent(A, 10, 20)] });

  ip.push(s1);
  ip.push(s2);

  ip.pull(100);
  const sd105 = ip.pull(105);
  const snapshot = sd105.smap.get(CID(A, PositionType));

  expect(snapshot?.payload).toBeInstanceOf(Position);
  expect(Pos(sd105, A)).toEqual({ x: 5, y: 10 });
});

test("does not interpolate entities that only exist in a future frame", () => {
  const ip = newInterpolator(3, 10);
  const s1 = SD({ from: 0, to: 1, snapshots: [makePosComponent(A, 0, 0)] });
  const s2 = SD({ from: 1, to: 2, snapshots: [makePosComponent(B, 10, 20)] });

  ip.push(s1);
  ip.push(s2);

  ip.pull(100);
  const sd105 = ip.pull(105);

  expect(Pos(sd105, B)).toBeUndefined();
});
