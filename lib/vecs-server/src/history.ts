import { IterableArrayMap } from "@vworlds/vecs";
import {
  ALL_COMPONENTS,
  EncodedSnapshot,
  StateDiff,
  type RemovedComponent,
} from "@vworlds/vecs-protocol";

/**
 * Default number of frames a session's {@link History} retains: the default of
 * `ServerWorldOptions.historyFrames`. 64 frames is about two seconds at 30 Hz.
 *
 * It is long because a baseline holds state back for a round trip, so the ack
 * lag peaks at twice its steady size right after one. A slot holds references
 * to already-encoded snapshots, and a delta merges only the frames since the
 * client's ack, so a long window costs little.
 */
export const HISTORY_LENGTH = 64;

/** Smallest window {@link validateHistoryFrames} accepts. */
const MIN_HISTORY_FRAMES = 2;

const REMOVED = 0;

type RemovedMarker = typeof REMOVED;
type Slot = EncodedSnapshot | RemovedMarker;

/**
 * What a pulled span did to one entity, keyed by wire type in a map, or `REMOVED` when
 * the entity was removed outright and nothing has re-created it since.
 *
 * A map holds, per component, its newest snapshot or `REMOVED` for a removal. A map that
 * also holds `REMOVED` under `ALL_COMPONENTS` describes an entity that was removed and
 * then snapshotted again within the span: a reset. It keeps no per-component removals,
 * because the entity it describes is new and simply lacks what was removed.
 */
type EntityHistory = IterableArrayMap<Slot> | RemovedMarker;

/**
 * Check a `historyFrames` value.
 *
 * @param frames - The requested window, in frames.
 * @returns `frames`, unchanged, once it is known to be valid.
 * @throws If `frames` is not an integer of at least 2.
 */
export function validateHistoryFrames(frames: number): number {
  if (!Number.isInteger(frames) || frames < MIN_HISTORY_FRAMES) {
    throw new Error(
      `historyFrames must be an integer of at least ${MIN_HISTORY_FRAMES}, got ${String(frames)}`
    );
  }
  return frames;
}

/**
 * The last `length` frames of one session's replication, each stored as the
 * {@link StateDiff} that took the client from the frame before it to that frame.
 *
 * A client that last acknowledged frame `n` can be caught up with a delta,
 * {@link History.pull}`(n, lastFrame)`, as long as nothing it is missing has
 * left the window. A frame that left the window while holding nothing, no
 * snapshot and no removal, took nothing with it: merging the frames that
 * remain gives exactly what merging all of them would. A frame that held
 * something is gone for good, and the client can no longer be caught up on it.
 * So the history remembers the newest frame that left while holding something,
 * {@link History.evictedContentFrame}, and a pull is possible exactly when
 * `n >= evictedContentFrame`. A session whose view has not changed for longer
 * than the window can therefore still be served a delta from an ack that is
 * older than the whole window.
 *
 * Within one frame's diff, a removal of a whole entity (`ALL_COMPONENTS`) precedes every
 * snapshot of that entity, so a snapshot in the same diff belongs to an entity that took
 * the eid after the removal. A pulled span keeps that meaning across frames: an entity
 * that was removed and snapshotted again within it is a reset, and the pulled diff
 * carries `ALL_COMPONENTS` for it together with its current snapshots, so a client that
 * never received the removal destroys the old entity before it builds the new one. A
 * span that holds no removal of the entity pulls its snapshots alone.
 */
export class History {
  private readonly _buffer: StateDiff[];
  private _lastFrame: number;
  private _evictedContentFrame = Number.NEGATIVE_INFINITY;

  public constructor(
    private readonly _length = HISTORY_LENGTH,
    lastFrame = -1
  ) {
    this._lastFrame = lastFrame;
    this._buffer = new Array<StateDiff>(_length);

    for (let i = 0; i < _length; i++) {
      const toFrame = lastFrame - i;
      this._buffer[this._index(toFrame)] = emptyDiff(toFrame);
    }
  }

  public get lastFrame(): number {
    return this._lastFrame;
  }

  public get oldestFrame(): number {
    return this._lastFrame - this._length + 1;
  }

  /**
   * The newest frame that has left the window while holding content, a
   * snapshot or a removal, or `-Infinity` while none has. A client whose ack is
   * older than this frame is missing something the history no longer has.
   */
  public get evictedContentFrame(): number {
    return this._evictedContentFrame;
  }

  public push(diff: StateDiff): void {
    if (diff.toFrame !== this._lastFrame + 1) {
      throw new Error(`Expected frame ${this._lastFrame + 1}, got ${diff.toFrame}`);
    }

    const slot = this._index(diff.toFrame);
    const evicted = this._buffer[slot];
    if (hasContent(evicted)) {
      this._evictedContentFrame = evicted.toFrame;
    }
    this._lastFrame = diff.toFrame;
    this._buffer[slot] = diff;
  }

  public get(frame: number): StateDiff {
    if (frame < this.oldestFrame || frame > this._lastFrame) {
      throw new Error(`Frame ${frame} is outside history window`);
    }

    return this._buffer[this._index(frame)];
  }

  /**
   * Whether a client that last acked frame `from` can be caught up by
   * {@link History.pull}`(from, lastFrame + 1)` once the next frame has been
   * pushed.
   *
   * The push evicts the oldest frame in the window, so this looks ahead to it:
   * the answer is the one the history will give after the push, which is what a
   * caller that decides before it builds the frame needs.
   */
  public canPullAfterPush(from: number): boolean {
    const leaving = this._buffer[this._index(this.oldestFrame)];
    const lost = hasContent(leaving) ? leaving.toFrame : this._evictedContentFrame;
    return from >= lost;
  }

  /**
   * Merge everything that changed after frame `from`, up to and including
   * frame `to`, into one diff labelled `from`..`to`.
   *
   * `from` is the frame the client really holds, so the label is always `from`,
   * never a later frame: the client rejects a diff that starts past its own.
   * `from` may be older than the window, provided no frame with content after it
   * has left it; only the frames still in the window are merged, because the
   * ones that left held nothing.
   *
   * @throws If a frame with content after `from` has left the window, or `to` is
   *   not a frame in it.
   */
  public pull(from: number, to: number): StateDiff {
    if (to < from) {
      throw new Error(`Invalid history range ${from}..${to}`);
    }

    if (to === from) {
      return new StateDiff({ fromFrame: from, toFrame: to });
    }

    if (from < this._evictedContentFrame) {
      throw new Error(`Frame ${this._evictedContentFrame} is outside history window`);
    }

    if (to === from + 1) {
      return this.get(to);
    }

    const entities = new IterableArrayMap<EntityHistory>();

    for (let frame = Math.max(from + 1, this.oldestFrame); frame <= to; frame++) {
      applyDiff(entities, this.get(frame));
    }

    return forgeDiff(from, to, entities);
  }

  private _index(frame: number): number {
    return ((frame % this._length) + this._length) % this._length;
  }
}

/**
 * Fold one frame's diff into the span being pulled, in the order a diff means: the
 * entities it removes outright, then its snapshots, then its removals of single components.
 */
function applyDiff(entities: IterableArrayMap<EntityHistory>, diff: StateDiff): void {
  diff.removed.forEach(([eid, wireType]) => {
    if (wireType === ALL_COMPONENTS) {
      entities.set(eid, REMOVED);
    }
  });

  diff.snapshots.forEach((snapshot) => {
    let entity = entities.get(snapshot.eid);

    if (entity === undefined) {
      entity = new IterableArrayMap<Slot>();
      entities.set(snapshot.eid, entity);
    } else if (entity === REMOVED) {
      // The entity was removed earlier in the span, and this snapshot is its replacement.
      // Remember the removal, so the pulled diff tells a client that never got it.
      entity = new IterableArrayMap<Slot>();
      entity.set(ALL_COMPONENTS, REMOVED);
      entities.set(snapshot.eid, entity);
    }

    entity.set(snapshot.wireType, snapshot);
  });

  diff.removed.forEach(([eid, wireType]) => {
    if (wireType === ALL_COMPONENTS) {
      return;
    }

    const entity = entities.get(eid);
    if (entity === REMOVED) {
      return;
    }

    if (entity === undefined) {
      const components = new IterableArrayMap<Slot>();
      components.set(wireType, REMOVED);
      entities.set(eid, components);
    } else if (entity.has(ALL_COMPONENTS)) {
      entity.delete(wireType);
    } else {
      entity.set(wireType, REMOVED);
    }
  });
}

function forgeDiff(from: number, to: number, entities: IterableArrayMap<EntityHistory>): StateDiff {
  const snapshots: EncodedSnapshot[] = [];
  const removed: RemovedComponent[] = [];

  entities.forEach((entity, eid) => {
    if (entity === REMOVED) {
      removed.push([eid, ALL_COMPONENTS]);
      return;
    }

    // A reset entity holds REMOVED under ALL_COMPONENTS, which comes out here as its
    // ALL_COMPONENTS removal, next to its snapshots.
    entity.forEach((slot, wireType) => {
      if (slot === REMOVED) {
        removed.push([eid, wireType]);
      } else {
        snapshots.push(slot);
      }
    });
  });

  return new StateDiff({ fromFrame: from, toFrame: to, snapshots, removed });
}

function hasContent(diff: StateDiff): boolean {
  return diff.snapshots.length > 0 || diff.removed.length > 0;
}

function emptyDiff(toFrame: number): StateDiff {
  return new StateDiff({
    fromFrame: toFrame - 1,
    toFrame,
    snapshots: [],
    removed: [],
  });
}
