import {
  ComponentSnapshot as WireComponentSnapshot,
  StateDiff,
  cid_pack,
  cid_unpack,
  type CID,
} from "@vworlds/vecs-protocol";
import { Decoder } from "@vworlds/vecs-wire";
import { type ComponentInstance, type EID } from "@vworlds/vecs";

const MAX_LENGTH = 3;

/**
 * The most optimistic diffs a {@link DiffBuffer} holds while it waits for the
 * frames before them: a round trip of frames, 8 of them at 30 Hz and a 250 ms
 * round trip. Holding is an optimization, so a full set evicts its oldest diff
 * without harm: the delta the server falls back to supersedes whatever is held.
 * The bound only caps memory when a server keeps sending optimistic diffs to a
 * client that cannot use them.
 */
export const MAX_HELD_DIFFS = 8;

export interface IPosition {
  x: number;
  y: number;
}

type DecodeComponentSnapshot = (snapshot: ComponentSnapshot) => ComponentInstance;

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
  public readonly wireType: number;
  public payload: Uint8Array | ComponentInstance;
  public readonly cid: CID;

  public constructor(eid: EID, wireType: number, payload: Uint8Array | ComponentInstance) {
    this.eid = eid;
    this.wireType = wireType;
    this.payload = payload;
    this.cid = cid_pack(eid, wireType);
  }
}

/**
 * The component snapshots, removals and resets for a frame range.
 *
 * `removed` holds the ids (`cid_pack(eid, wireType)`) of single components that
 * are gone. `resets` holds the entities that are gone altogether, each with the
 * server frame of its newest removal. Within one diff the changes apply in a
 * fixed order, the one `ClientWorld.apply` follows:
 *
 * 1. the resets, which destroy their entities;
 * 2. the snapshots, which create or update entities;
 * 3. the removals of single components.
 *
 * So a snapshot of an eid that the same diff resets belongs to the entity that
 * took the eid after the removal, never to the one removed. {@link merge} keeps
 * that meaning when it joins diffs.
 *
 * A reset is idempotent, because the server repeats it in every delta whose
 * span includes it: {@link DiffBuffer.pull} hands out only the resets whose
 * frame is newer than the state the pull starts from. The others were applied
 * already, and the snapshots and removals that follow them apply in place.
 *
 * A diff keeps two views of the same snapshots: `snapshots` (an ordered array,
 * the form decoded from the wire and consumed by callers) and `smap` (a
 * cid-keyed map, used for fast lookup and overwrite during merge). `smap` is
 * built lazily from `snapshots` on first access. Use `getSnapshot` /
 * `upsertSnapshot` when keyed access should preserve the current representation.
 */
export class Diff {
  public snapshots: ComponentSnapshot[] = [];
  /**
   * The entities this diff removes outright, each with the server frame of its newest removal,
   * or `undefined` when it removes none, which is the usual diff and allocates nothing.
   */
  public resets: Map<EID, number> | undefined;
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
    return new ComponentSnapshot(wire.eid, wire.wireType, wire.payload);
  });
  d.removed = sd.removed.map(([eid, wireType]) => cid_pack(eid, wireType));
  if (sd.resets.length > 0) {
    d.resets = new Map(sd.resets);
  }
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

  // held contains the optimistic diffs that start past `version`: frames the
  // server marked as built on a base this client has not received yet. They wait
  // for it, and are applied by push() as soon as version reaches their start, or
  // dropped once version has passed their end. At most MAX_HELD_DIFFS.
  private readonly _held: Diff[] = [];

  // gap is set whenever a diff is held and cleared by takeGap(): the client has
  // something to tell the server since the last time it asked.
  private _gap = false;

  // tServ tracks the server time approximately
  private _tServ = -1;

  // lastTime contains the timestamp for the last pull() call and is used as
  // the moving interpolation baseline when pull() is called before tServ.
  private _lastTime = -1;

  // renderFrame is the fractional server frame the last pull() rendered; see
  // the renderFrame getter.
  private _renderFrame = 0;

  // componentInterpolators maps a wire type id to the function used to
  // blend it between server frames. Types without an entry are snapped to their
  // latest value. No interpolators are registered by default; callers must opt
  // in by passing an entry (e.g. wiring `interpolatePosition` to the wire type
  // of their position-like component).
  private readonly _componentInterpolators: Map<number, ComponentInterpolator>;

  public constructor(
    private max_length: number = MAX_LENGTH, // max bucket length
    private server_tick_interval: number = 1000 / 60, // server tick interval FPS configuration
    private readonly _decodeComponentSnapshot?: DecodeComponentSnapshot,
    componentInterpolators: Iterable<readonly [number, ComponentInterpolator]> = []
  ) {
    if (max_length < 2) {
      throw new Error("minimum interpolation bucket length is 2");
    }
    this.bucket = Array(this.max_length).fill(undefined);
    this._componentInterpolators = new Map(componentInterpolators);
  }

  /**
   * The server frame the last {@link DiffBuffer.pull} rendered, fractional while it interpolates.
   *
   * It is the frame of the state the pull blends from, moved toward the frame it blends to by
   * the same `alpha` it hands the interpolators. From an applied frame N toward N + 1 that is
   * `N + alpha`. A pull that applies no new frame blends from the values the previous pull
   * rendered, so it also blends from the previous `renderFrame`, which keeps it on the frame the
   * interpolated components show. It is computed whether or not interpolators are registered.
   *
   * `0` until a frame is applied, and again after {@link DiffBuffer.reset}. Between resets it
   * never decreases for a non-decreasing `now`, and it never passes {@link DiffBuffer.version},
   * the newest frame received: when the bucket runs dry it holds at the newest frame applied.
   */
  public get renderFrame(): number {
    return this._renderFrame;
  }

  private _updateState(sd: Diff): void {
    // apply diff to current state, in the order a diff means: the entities it resets, then
    // its snapshots (which may belong to a new entity under a reset eid), then its component
    // removals.
    const resets = sd.resets;
    if (resets !== undefined) {
      this._state.forEach((_, cid) => {
        if (resets.has(cid_unpack(cid)[0])) {
          this._state.delete(cid);
        }
      });
    }
    sd.snapshots?.forEach((s) => {
      this._state.set(s.cid, s);
    });
    sd.removed?.forEach((r) => {
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
    // renderFrom is the server frame of the state interpolation blends from:
    // the point the previous pull rendered, unless this pull applies a frame.
    let renderFrom = this._renderFrame;

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
      renderFrom = sd.to;
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
    // A reset the pull starts past is one the world applied already, in an earlier delta that
    // overlapped this one. Only the resets that remain destroy an entity: they are the eids
    // whose rendered state _updateState drops, and _interpolate must not blend from.
    dropAppliedResets(sd);

    // At this point, if something is in the bucket, bucket[0] contains the
    // next target. Position snapshots are blended into the returned diff so
    // callers can render fake frames between server ticks.
    const target = this.bucket[0];
    if (target) {
      const end = this._tServ;
      const alpha =
        end === interpolationStart ? 1 : (now - interpolationStart) / (end - interpolationStart);
      this._interpolate(sd, target, alpha);
      // The interpolators blend from the state at renderFrom toward the
      // target with this alpha, so the frame they render is the same blend.
      // Until a frame is applied (sd.to is 0) there is no state to blend
      // from, and nothing is rendered.
      this._renderFrame = sd.to === 0 ? 0 : renderFrom + (target.to - renderFrom) * alpha;
      this._first = target.to;
    } else {
      this._renderFrame = sd.to;
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
    this._held.length = 0;
    this._gap = false;
    this.version = -1;
    this._first = undefined;
    this._stateVersion = 0;
    this._tServ = -1;
    this._lastTime = -1;
    this._renderFrame = 0;
  }

  /**
   * Put a diff received from the wire in its place in the bucket.
   *
   * After {@link DiffBuffer.reset}, and before anything has been received
   * (`version` is `-1`), the first diff starts the stream whatever frame it
   * names: a new connection may be to a server whose frame counter restarted.
   * From then on a diff is judged against `version`, the newest frame received:
   *
   * - one that starts past it is rejected, because a server that honors acks
   *   never sends one, unless the server marked it optimistic: then it is held
   *   until `version` reaches its start (see the `optimistic` parameter);
   * - one for a frame the client already has is stale, a datagram the unordered
   *   channel delivered late or twice, and is discarded when the bucket has
   *   drained (it would otherwise become the new starting point and roll
   *   `version` back), or when it is older than everything still buffered;
   *   one for a frame that is still buffered merges into it, as a retransmit.
   *
   * Resets in held diffs wait with their snapshots. Release advances received `version`, but
   * reset deduplication happens in {@link DiffBuffer.pull}, against the rendered state's
   * starting frame, so an unapplied reset is never mistaken for an already-applied one.
   *
   * @param diff - The diff to buffer.
   * @param optimistic - The server marked the diff optimistic: it may start past
   *   the newest frame received, because it presumes the frames in between were
   *   delivered. Such a diff is held until they arrive instead of rejected; see
   *   {@link DiffBuffer.takeGap}.
   * @throws If the diff starts after the newest frame this buffer has received and is
   *   not optimistic.
   */
  public push(diff: Diff, optimistic = false): void {
    if (this.version >= 0 && diff.from > this.version) {
      if (!optimistic) {
        throw new Error(
          `diff starts at frame ${diff.from}, past this client's frame ${this.version}`
        );
      }
      this._hold(diff);
      return;
    }
    this._accept(diff);
    if (this._held.length > 0) {
      this._releaseHeld();
    }
  }

  /**
   * Whether the client should tell the server about a gap now, clearing the flag.
   *
   * A gap is an optimistic diff that arrived before the frames it was built on.
   * It is open while a diff is still held. Returns `true` once per detection, and
   * only if the gap has not closed in the meantime: a late or reordered frame
   * that arrives before the next ack releases the held diff, and the server has
   * nothing to fall back for.
   */
  public takeGap(): boolean {
    const open = this._gap && this._held.length > 0;
    this._gap = false;
    return open;
  }

  // accept puts a diff that starts within `version` in its place in the bucket.
  private _accept(diff: Diff): void {
    // in case of buffer empty or first diff, initialize everything:
    if (this._first === undefined) {
      // An empty bucket does not mean nothing has been received: once pull() has
      // consumed the buffered frames, `version` still names the newest frame this
      // client has, and only reset() (which makes it -1) starts the stream over. A
      // diff for a frame the client already has, a datagram the unordered channel
      // delivered late or twice, must not become the new starting point: it would
      // roll `version` back below the frame the server last saw acked, and the next
      // real diff, which starts there, would then look as if it started past this
      // client's frame. So a stale diff is discarded, and one that starts past
      // `version` is judged as it is below.
      if (this.version >= 0) {
        if (diff.to <= this.version) {
          return;
        }
      }
      this.bucket[0] = diff;
      this._first = diff.to;
      this.version = diff.to;
      return;
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

  // hold keeps an optimistic diff that starts past `version` until the frames it
  // was built on arrive. A diff for a frame that is already held, a datagram the
  // unordered channel delivered twice, keeps the older start. A full set drops its
  // oldest diff to make room.
  private _hold(diff: Diff): void {
    this._gap = true;
    const duplicate = this._held.findIndex((held) => held.to === diff.to);
    if (duplicate !== -1) {
      this._held[duplicate] =
        this._held[duplicate].from <= diff.from ? this._held[duplicate] : diff;
      return;
    }
    if (this._held.length >= MAX_HELD_DIFFS) {
      this._held.splice(this._oldestHeld(), 1);
    }
    this._held.push(diff);
  }

  // releaseHeld applies the held diffs that `version` has reached, oldest first
  // because applying one can bring the next within reach, and drops the ones that
  // `version` has passed.
  private _releaseHeld(): void {
    for (;;) {
      for (let i = this._held.length - 1; i >= 0; i--) {
        if (this._held[i].to <= this.version) {
          this._held.splice(i, 1);
        }
      }
      const next = this._oldestReachableHeld();
      if (next === -1) {
        return;
      }
      const [diff] = this._held.splice(next, 1);
      this._accept(diff);
    }
  }

  private _oldestHeld(): number {
    let oldest = 0;
    for (let i = 1; i < this._held.length; i++) {
      if (this._held[i].to < this._held[oldest].to) {
        oldest = i;
      }
    }
    return oldest;
  }

  private _oldestReachableHeld(): number {
    let oldest = -1;
    for (let i = 0; i < this._held.length; i++) {
      if (
        this._held[i].from <= this.version &&
        (oldest === -1 || this._held[i].to < this._held[oldest].to)
      ) {
        oldest = i;
      }
    }
    return oldest;
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

  private _interpolate(sd: Diff, target: Diff, alpha: number): void {
    if (this._componentInterpolators.size === 0) {
      return;
    }
    // An entity the target resets is replaced by the one whose snapshots follow in the target:
    // it has no previous state to blend from, so it snaps to its first values. The target
    // resets it only if its reset is newer than the state this pull reaches: an older one is
    // applied already, and the entity blends as any other. Likewise an entity the rendered
    // diff reset: what the rendered state holds under its eid belongs to the removed one, and
    // only the snapshots the diff itself holds are the new entity's.
    const targetResets = target.resets;
    const renderedResets = sd.resets;
    target.snapshots.forEach((targetSnapshot) => {
      const interpolate = this._componentInterpolators.get(targetSnapshot.wireType);
      if (!interpolate) {
        return;
      }
      const targetResetFrame = targetResets?.get(targetSnapshot.eid);
      if (targetResetFrame !== undefined && targetResetFrame > sd.to) {
        return;
      }
      const sourceSnapshot =
        sd.getSnapshot(targetSnapshot.cid) ??
        (renderedResets?.has(targetSnapshot.eid) ? undefined : this._state.get(targetSnapshot.cid));
      if (!sourceSnapshot) {
        return;
      }
      const source = this._decodeSnapshot(sourceSnapshot);
      const targetComponent = this._decodeSnapshot(targetSnapshot);
      sd.upsertSnapshot(
        new ComponentSnapshot(
          targetSnapshot.eid,
          targetSnapshot.wireType,
          interpolate(source, targetComponent, alpha)
        )
      );
    });
  }
}

/**
 * Built-in {@link ComponentInterpolator} for 2D point components: linearly
 * interpolates the `x` and `y` fields. Not registered by default; callers that
 * want position interpolation must wire it to their position-like component's
 * wire type explicitly, e.g. `[[Position.wireType, interpolatePosition]]`.
 * Exported so callers can interpolate their own position-like components
 * without reimplementing the math.
 */
export const interpolatePosition: ComponentInterpolator = ((
  source: object & IPosition,
  target: object & IPosition & { constructor: new () => ComponentInstance },
  alpha: number
) => {
  const result = new target.constructor() as IPosition;
  result.x = source.x + (target.x - source.x) * alpha;
  result.y = source.y + (target.y - source.y) * alpha;
  return result;
}) as ComponentInterpolator;

// helper function to add items to a set
function addToSet<T>(set: Set<T>, data: Iterable<T> | undefined): void {
  if (!data) {
    return;
  }
  for (const item of data) {
    set.add(item);
  }
}

// Drop from `diff` the resets the world applied already: those whose frame is not past the
// state `diff` starts from. A delta starts at the newest frame the server has seen acked, so
// deltas that overlap while an ack is in flight each repeat a reset, and the frame is what tells
// a repeat from a new removal. Allocates nothing unless the diff holds resets.
function dropAppliedResets(diff: Diff): void {
  const resets = diff.resets;
  if (resets === undefined) {
    return;
  }
  resets.forEach((frame, eid) => {
    if (frame <= diff.from) {
      resets.delete(eid);
    }
  });
  if (resets.size === 0) {
    diff.resets = undefined;
  }
}

// The eids that b resets and a does not, or resets at an older frame. What a holds of them
// describes the entity b removed. Undefined when there are none, which is the usual merge.
function supersededBy(b: Diff, a: Diff): Set<EID> | undefined {
  if (b.resets === undefined) {
    return undefined;
  }
  let eids: Set<EID> | undefined;
  for (const [eid, frame] of b.resets) {
    const known = a.resets?.get(eid);
    if (known === undefined || frame > known) {
      (eids ??= new Set()).add(eid);
    }
  }
  return eids;
}

// The resets of a merged diff: the newest frame of each eid. `mutateAccumulator` lets the result
// reuse a's map; without it, a and b keep their own.
function mergeResets(a: Diff, b: Diff, mutateAccumulator: boolean): Map<EID, number> | undefined {
  if (b.resets === undefined) {
    return mutateAccumulator || a.resets === undefined ? a.resets : new Map(a.resets);
  }
  const merged = mutateAccumulator && a.resets !== undefined ? a.resets : new Map(a.resets);
  for (const [eid, frame] of b.resets) {
    const known = merged.get(eid);
    if (known === undefined || frame > known) {
      merged.set(eid, frame);
    }
  }
  return merged;
}

// merge returns the result of merging Diff b on to a, where b is the newer diff.
//
// A diff applies its resets first, then its snapshots, then its removals of single components
// (see Diff), and merge keeps that meaning. The result holds the newest frame of each eid's
// reset, and:
//
// - A reset in b that is newer than the one a holds for the eid, or a holds none, ends the
//   entity a describes: a's snapshots and component removals for the eid are dropped, and the
//   reset stays in the result together with b's snapshots of the eid, which belong to the
//   entity that took the eid after the removal.
// - A reset in b that is not newer than a's is the same removal, repeated by an overlapping
//   delta: what a holds for the eid follows it, and stays, merged with b's.
// - A reset in a stays when b holds snapshots of the eid: they are the entity that took the
//   eid after the removal, merged with a's own snapshots of it.
// - A snapshot in b of a component that a removed un-deletes it, and a removal in b of a
//   component that a snapshots deletes it. A removal stays in the result next to a reset of
//   its entity: a client that has applied the reset already still needs it.
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

  // The eids whose entity b resets, replacing the one a describes. Only a merge that has an
  // entity to replace pays for the extra passes below, and for the set.
  const superseded = supersededBy(b, a);
  const resets = mergeResets(a, b, mutateAccumulator);

  const removed = new Set<number>();
  addToSet(removed, a.removed as number[] | undefined);
  if (superseded !== undefined) {
    // a's component removals of an entity b resets are moot.
    removed.forEach((r) => {
      if (superseded.has(cid_unpack(r)[0])) {
        removed.delete(r);
      }
    });
  }
  addToSet(removed, b.removed as number[] | undefined);

  const as = mutateAccumulator ? a.smap : new Map(a.smap);
  if (superseded !== undefined) {
    // a's snapshots of an entity b resets describe the removed entity.
    as.forEach((_, cid) => {
      if (superseded.has(cid_unpack(cid)[0])) {
        as.delete(cid);
      }
    });
  }
  const bs = b.smap;
  bs.forEach((s) => {
    as.set(s.cid, s);
    removed.delete(s.cid); // undelete re-added entities
  });
  removed.forEach((r) => as.delete(r));

  const m = mutateAccumulator ? a : new Diff(a.from, b.to, undefined);
  m.to = b.to;
  m.removed = removed.size ? [...removed] : undefined;
  m.resets = resets;
  m.smap = as;

  return m;
}
