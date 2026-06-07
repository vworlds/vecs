import {
  ALL_COMPONENTS,
  ComponentSnapshot as WireComponentSnapshot,
  StateDiff,
  cid_pack,
  cid_unpack,
  type CID,
} from "@vworlds/vecs-protocol";
import { Decoder } from "@vworlds/vecs-wire";
import { type ComponentInstance, type EID } from "@vworlds/vecs";

const MAX_LENGTH = 3;
const POSITION_COMPONENT_TYPE = 1;

export interface IPosition {
  readonly x: number;
  readonly y: number;
}

type DecodeComponentSnapshot = (snapshot: ComponentSnapshot) => ComponentInstance;
type PositionComponent = ComponentInstance & IPosition;

/**
 * Blends a source and target component toward render time. `alpha` is the
 * normalized interpolation factor in the range [0, 1], where 0 returns the
 * source value and 1 the target value. The returned value should be a fresh
 * component instance; inputs must not be mutated.
 */
export type ComponentInterpolator = (
  source: ComponentInstance,
  target: ComponentInstance,
  alpha: number
) => ComponentInstance;

export class ComponentSnapshot {
  public readonly eid: EID;
  public readonly type: number;
  public payload: Uint8Array | ComponentInstance;
  public readonly cid: CID;

  public constructor(eid: EID, type: number, payload: Uint8Array | ComponentInstance) {
    this.eid = eid;
    this.type = type;
    this.payload = payload;
    this.cid = cid_pack(eid, type);
  }
}

// A Diff carries the component snapshots and removals for a frame range. It
// keeps two views of the same snapshots: `snapshots` (an ordered array, the
// form decoded from the wire and consumed by callers) and `smap` (a cid-keyed
// map, used for fast lookup and overwrite during merge). `smap` is built
// lazily from `snapshots` on first access. Use `getSnapshot`/`upsertSnapshot`
// when keyed access should preserve the current representation.
export class Diff {
  public snapshots: ComponentSnapshot[] = [];
  private _smap: Map<number, ComponentSnapshot> | undefined;

  public constructor(
    public from: number,
    public to: number,
    public removed?: number[]
  ) {}

  public get smap(): Map<number, ComponentSnapshot> {
    if (this._smap) {
      return this._smap;
    }
    return (this._smap = new Map<number, ComponentSnapshot>(
      (this.snapshots || []).map((s) => [s.cid, s])
    ));
  }

  public set smap(v: Map<number, ComponentSnapshot>) {
    this._smap = v;
    this.updateSnapshotsFromMap();
  }

  public getSnapshot(cid: CID): ComponentSnapshot | undefined {
    if (this._smap) {
      return this._smap.get(cid);
    }
    return this.snapshots.find((snapshot) => snapshot.cid === cid);
  }

  public upsertSnapshot(snapshot: ComponentSnapshot): void {
    if (this._smap) {
      this._smap.set(snapshot.cid, snapshot);
      this.updateSnapshotsFromMap();
      return;
    }
    const index = this.snapshots.findIndex((existing) => existing.cid === snapshot.cid);
    if (index === -1) {
      this.snapshots.push(snapshot);
      return;
    }
    this.snapshots[index] = snapshot;
  }

  public updateSnapshotsFromMap(): void {
    this.snapshots = [...this.smap.values()];
  }
}

export function diffFromStateDiff(sd: StateDiff): Diff {
  const d = new Diff(sd.fromFrame, sd.toFrame);
  d.snapshots = sd.snapshots.map((snapshot) => {
    const wire = new Decoder(snapshot.bytes).read(WireComponentSnapshot);
    return new ComponentSnapshot(wire.eid, wire.type, wire.payload);
  });
  d.removed = sd.removed.map(([eid, type]) => cid_pack(eid, type));
  return d;
}

export class DiffBuffer {
  // state contains the state the game is currently rendering.
  private _state = new Map<number, ComponentSnapshot>();
  private _stateVersion: number = 0;

  // first has the version of the first element in the bucket
  // if first is undefined, then the bucket is empty
  private _first: number | undefined = undefined;

  // bucket is a buffer of state diff snapshots
  public readonly bucket: Array<Diff | undefined>;

  // version indicates the last version received by the server
  // that can be acknowledged
  public version: number = -1;

  // tServ tracks the server time approximately
  private _tServ = -1;

  // lastTime contains the timestamp for the last pull() call and is used as
  // the moving interpolation baseline when pull() is called before tServ.
  private _lastTime = -1;

  // componentInterpolators maps a component type id to the function used to
  // blend it between server frames. Types without an entry are snapped to their
  // latest value.
  private readonly _componentInterpolators: Map<number, ComponentInterpolator>;

  public constructor(
    private max_length: number = MAX_LENGTH, // max bucket length
    private server_tick_interval: number = 1000 / 60, // server tick interval FPS configuration
    private readonly _decodeComponentSnapshot?: DecodeComponentSnapshot,
    componentInterpolators: Iterable<readonly [number, ComponentInterpolator]> = [
      [POSITION_COMPONENT_TYPE, interpolatePosition],
    ]
  ) {
    if (max_length < 2) {
      throw new Error("minimum interpolation bucket length is 2");
    }
    this.bucket = Array(this.max_length).fill(undefined);
    this._componentInterpolators = new Map(componentInterpolators);
  }

  private _updateState(sd: Diff): void {
    // apply diff to current state
    sd.snapshots?.forEach((s) => {
      this._state.set(s.cid, s);
    });
    (sd.removed as number[] | undefined)?.forEach((r) => {
      const [eid, type] = cid_unpack(r);
      if (type === ALL_COMPONENTS) {
        this._state.forEach((_, cid) => {
          if (cid_unpack(cid)[0] === eid) {
            this._state.delete(cid);
          }
        });
        return;
      }
      this._state.delete(r);
    });
    this._stateVersion = sd.to;
  }

  // pop removes the first element of the bucket
  // shifting all elements to the left.
  private _pop(): void {
    for (let j = 0; j < this.bucket.length - 1; j++) {
      this.bucket[j] = this.bucket[j + 1];
    }
    this.bucket[this.bucket.length - 1] = undefined;
  }

  // pull returns a constructed Diff from elements
  // in the bucket + interpolation
  public pull(now: number): Diff {
    const next = this.bucket[0];
    let sd = new Diff(this._stateVersion, this._stateVersion, undefined);
    if (next === undefined) {
      // there is nothing in the buffer, so return an empty diff
      // since we are hitting an empty buffer, allow some extra time for it
      // to replenish, by delaying the server time.
      this._tServ = now + this.server_tick_interval * this.bucket.length;
      this._first = undefined;
      this._lastTime = now;
      return sd; // return empty diff
    }
    if (this._tServ === -1) {
      this._tServ = now;
    }

    // interpolationStart is the timestamp of the currently visualized state.
    let interpolationStart = this._lastTime;

    // The following loop will incorporate (merge) into the
    // proposed diff (sd) as many snapshots from the bucket
    // as it needs in order to catch up to server time, that is,
    // if we are ahead of the server timestamp, merge
    // snapshots until we are behind
    // or have eaten the whole buffer.
    for (
      let i = 0;
      i < this.bucket.length && now >= this._tServ;
      i++, this._tServ += this.server_tick_interval
    ) {
      // take snapshot on bucket[0] and merge it on to the result. sd is owned
      // exclusively by this pull(), so fold each frame in place to avoid copying
      // the snapshot map on every iteration.
      sd = merge(sd, this.bucket[0], false, true);
      interpolationStart = this._tServ;
      this._pop(); //remove bucket[0] and shift contents to the left
    }

    // skip bucket items that are undefined. At the end of this
    // loop either bucket[0] has a diff or the whole bucket is empty.
    // we only alter tServ if something was actually in the bucket at all.
    let tsDelta = 0;
    for (let i = 0; i < this.bucket.length; i++) {
      if (this.bucket[0]) {
        this._tServ += tsDelta;
        break;
      }
      this._pop();
      tsDelta += this.server_tick_interval;
    }
    // At this point, if something is in the bucket, bucket[0] contains the
    // next target. Position snapshots are blended into the returned diff so
    // callers can render fake frames between server ticks.
    const target = this.bucket[0];
    if (target) {
      this._interpolate(sd, target, interpolationStart, this._tServ, now);
      this._first = target.to;
    } else {
      this._first = undefined;
    }

    // incorporate this diff into our visualization of the state prior
    // to handing this diff out to the scene:
    this._updateState(sd);
    this._lastTime = now;
    return sd;
  }

  public reset(): void {
    this._state.clear();
    this.bucket.fill(undefined);
    this.version = -1;
    this._first = undefined;
    this._stateVersion = 0;
    this._tServ = -1;
    this._lastTime = -1;
  }

  // push takes diffs coming from the wire and incorporates them
  // to the snapshot bucket in the right position:
  public push(diff: Diff): void {
    // in case of buffer empty or first diff, initialize everything:
    if (this._first === undefined) {
      this.bucket[0] = diff;
      this._first = diff.to;
      this.version = diff.to;
      return;
    }

    // servers should never send a diff we can't handle
    // The below can only happen if the server is ignoring acks:
    if (diff.from > this.version) {
      throw new Error("protocol error");
    }

    // Locate the index position for this diff in the bucket based on the
    // version of the first item in the bucket:
    let index = diff.to - this._first;

    // negative index means this information is too old:
    if (index < 0) {
      return; // too old. Discard
    }
    if (index >= this.bucket.length) {
      // index falls out of the bucket, meaning
      // there is old information in the bucket.
      let d = index - (this.bucket.length - 1);
      if (d >= this.bucket.length) {
        // information in the bucket is extremely old
        // we will merge everything on to bucket[0] + this diff
        this._first = diff.to;
        d = this.bucket.length;
        index = 0;
      } else {
        // information was old, but it can be fixed by
        // merging partially.
        index = this.bucket.length - d;
      }
      // the following loop merges as much as needed to make
      // space for the incoming diff.
      for (let i = 0; i < d; i++) {
        this.bucket[0] = merge(this.bucket[0], this.bucket[1]);
        for (let j = 1; j < this.bucket.length - 1; j++) {
          this.bucket[j] = this.bucket[j + 1];
        }
        this.bucket[this.bucket.length - 1] = undefined;
      }
    }
    // merge the incoming diff with whatever is at the target
    // index, normally undefined, but it could be a retransmit
    // of the same frame.
    this.bucket[index] = merge(this.bucket[index], diff);

    // bucket[0] can never be undefined. If so, there is something wrong
    // with the algorithm itself.
    if (this.bucket[0] === undefined) {
      throw new Error("bucket[0] is undefined");
    }
    this._first = this.bucket[0].to;

    // setting `version` allows the session layer to ack this diff.
    if (diff.to > this.version) {
      this.version = diff.to;
    }
  }

  private _decodeSnapshot(snapshot: ComponentSnapshot): ComponentInstance {
    if (!(snapshot.payload instanceof Uint8Array)) {
      return snapshot.payload;
    }
    if (!this._decodeComponentSnapshot) {
      throw new Error("Component interpolation requires a component snapshot decoder");
    }
    return this._decodeComponentSnapshot(snapshot);
  }

  private _interpolate(sd: Diff, target: Diff, start: number, end: number, now: number): void {
    if (this._componentInterpolators.size === 0) {
      return;
    }
    const alpha = end === start ? 1 : (now - start) / (end - start);
    target.snapshots.forEach((targetSnapshot) => {
      const interpolate = this._componentInterpolators.get(targetSnapshot.type);
      if (!interpolate) {
        return;
      }
      const sourceSnapshot =
        sd.getSnapshot(targetSnapshot.cid) ?? this._state.get(targetSnapshot.cid);
      if (!sourceSnapshot) {
        return;
      }
      const source = this._decodeSnapshot(sourceSnapshot);
      const targetComponent = this._decodeSnapshot(targetSnapshot);
      sd.upsertSnapshot(
        new ComponentSnapshot(
          targetSnapshot.eid,
          targetSnapshot.type,
          interpolate(source, targetComponent, alpha)
        )
      );
    });
  }
}

function isPosition(component: ComponentInstance): component is PositionComponent {
  const candidate = component as Partial<IPosition>;
  return typeof candidate.x === "number" && typeof candidate.y === "number";
}

/**
 * Default {@link ComponentInterpolator} for 2D point components: linearly
 * interpolates the `x` and `y` fields. Exported so callers can interpolate
 * their own position-like components without reimplementing the math.
 */
export const interpolatePosition: ComponentInterpolator = (source, target, alpha) => {
  if (!isPosition(source) || !isPosition(target)) {
    throw new Error(`Component type ${POSITION_COMPONENT_TYPE} must satisfy IPosition`);
  }
  const result = new (target.constructor as new () => ComponentInstance & {
    x: number;
    y: number;
  })();
  result.x = source.x + (target.x - source.x) * alpha;
  result.y = source.y + (target.y - source.y) * alpha;
  return result;
};

// helper function to add items to a set
function addToSet<T>(set: Set<T>, data: Iterable<T> | undefined): void {
  if (!data) {
    return;
  }
  for (const item of data) {
    set.add(item);
  }
}

// merge returns the result of merging Diff b on to a.
//
// When `mutateAccumulator` is true the caller asserts it exclusively owns `a`
// (a fresh accumulator), letting merge fold `b` into `a` in place. This skips
// the defensive copy of a's snapshot map, which otherwise allocates and rehashes
// the whole map on every step of the pull() catch-up loop. The default keeps
// merge pure: `a` and `b` are left untouched and a new Diff is returned.
export function merge(
  a: Diff | undefined,
  b: Diff,
  check?: boolean,
  mutateAccumulator?: boolean
): Diff;
export function merge(
  a: Diff,
  b: Diff | undefined,
  check?: boolean,
  mutateAccumulator?: boolean
): Diff;
export function merge(
  a: Diff | undefined,
  b: Diff | undefined,
  check?: boolean,
  mutateAccumulator?: boolean
): Diff | undefined;
export function merge(
  a: Diff | undefined,
  b: Diff | undefined,
  check = true,
  mutateAccumulator = false
): Diff | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }

  if (check && (b.from || 0) > (a.to || 0)) {
    // This is a protocol error.
    // can only happen if server ignored our ACKs and
    // incremented version counter on its own.
    throw new Error("cannot merge snapshots");
  }

  const removed = new Set<number>();
  addToSet(removed, a.removed as number[] | undefined);
  addToSet(removed, b.removed as number[] | undefined);

  const as = mutateAccumulator ? a.smap : new Map(a.smap);
  const bs = b.smap;
  bs.forEach((s) => {
    as.set(s.cid, s);
    removed.delete(s.cid); // undelete re-added entities
  });
  removed.forEach((r) => as.delete(r));

  const m = mutateAccumulator ? a : new Diff(a.from, b.to, undefined);
  m.to = b.to;
  m.removed = removed.size ? [...removed] : undefined;
  m.smap = as;

  return m;
}
