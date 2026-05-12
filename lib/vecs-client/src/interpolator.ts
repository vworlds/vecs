import { ComponentSnapshot as WireComponentSnapshot, StateDiff } from "@vworlds/vecs-protocol";
import { Decoder } from "@vworlds/vecs-wire";

const MAX_LENGTH = 3;

export class ComponentSnapshot {
  public readonly eid: number;
  public readonly type: number;
  public readonly payload: Uint8Array;
  public readonly id: number;

  public constructor(eid: number, type: number, payload: Uint8Array) {
    this.eid = eid;
    this.type = type;
    this.payload = payload;
    this.id = (eid << 8) | (type & 0xff);
  }
}

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
      (this.snapshots || []).map((s) => [s.id, s])
    ));
  }

  public set smap(v: Map<number, ComponentSnapshot>) {
    this._smap = v;
    this.updateSnapshotsFromMap();
  }

  public updateSnapshotsFromMap(): void {
    this.snapshots = [...this.smap.values()];
  }
}

export function diffFromStateDiff(sd: StateDiff): Diff {
  const d = new Diff(sd.fromFrame, sd.toFrame);
  d.snapshots = sd.snapshots.map((bytes) => {
    const wire = new Decoder(bytes).read(WireComponentSnapshot);
    return new ComponentSnapshot(wire.eid, wire.type, wire.payload);
  });
  d.removed = sd.removed.map((r) => snapshotKey(r.eid, r.type));
  return d;
}

function snapshotKey(eid: number, type: number): number {
  return (eid << 8) | (type & 0xff);
}

export class Interpolator {
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

  public constructor(
    private max_length: number = MAX_LENGTH, // max bucket length
    private server_tick_interval: number = 1000 / 60 // server tick interval FPS configuration
  ) {
    if (max_length < 2) {
      throw "minimum interpolation bucket length is 2";
    }
    this.bucket = Array(this.max_length).fill(undefined);
  }

  private _updateState(sd: Diff): void {
    // apply diff to current state
    sd.snapshots?.forEach((s) => {
      this._state.set(s.id, s);
    });
    (sd.removed as number[] | undefined)?.forEach((r) => {
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
      return sd; // return empty diff
    }
    if (this._tServ === -1) {
      this._tServ = now;
    }

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
      // take snapshot on bucket[0] and merge it on to the result:
      sd = merge(sd, this.bucket[0], false);
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
    // At this point, if something is in the bucket,
    // bucket[0] contains the next target. With lerp disabled, we do not
    // mix any of its components into the current diff yet — they will
    // arrive whole on a future pull when tServ has advanced past it.
    const target = this.bucket[0];
    if (target) {
      this._first = target.to;
    } else {
      this._first = undefined;
    }

    // incorporate this diff into our visualization of the state prior
    // to handing this diff out to the scene:
    this._updateState(sd);
    return sd;
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
      throw "protocol error";
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
      throw "bucket[0] is undefined";
    }
    this._first = this.bucket[0].to;

    // setting `version` allows the session layer to ack this diff.
    if (diff.to > this.version) {
      this.version = diff.to;
    }
  }
}

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
export function merge(a: Diff | undefined, b: Diff, check?: boolean): Diff;
export function merge(a: Diff, b: Diff | undefined, check?: boolean): Diff;
export function merge(a: Diff | undefined, b: Diff | undefined, check?: boolean): Diff | undefined;
export function merge(a: Diff | undefined, b: Diff | undefined, check = true): Diff | undefined {
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
    throw "cannot merge snapshots";
  }
  const m = new Diff(a.from, b.to, undefined);

  const removed = new Set<number>();
  addToSet(removed, a.removed as number[] | undefined);
  addToSet(removed, b.removed as number[] | undefined);

  const as = new Map(a.smap);
  const bs = b.smap;
  bs.forEach((s) => {
    as.set(s.id, s);
    removed.delete(s.id); // undelete re-added entities
  });
  removed.forEach((r) => as.delete(r));

  if (removed.size) {
    m.removed = [...removed];
  }
  m.smap = as;

  return m;
}
