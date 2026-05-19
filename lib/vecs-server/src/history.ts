import { ArrayMap } from "@vworlds/vecs";
import {
  ALL_COMPONENTS,
  EncodedSnapshot,
  StateDiff,
  type RemovedComponent,
} from "@vworlds/vecs-protocol";

export const HISTORY_LENGTH = 5;

const REMOVED = 0;

type RemovedMarker = typeof REMOVED;
type Slot = EncodedSnapshot | RemovedMarker;
type EntityHistory = ArrayMap<Slot> | RemovedMarker;

export class History {
  private readonly _buffer: StateDiff[];
  private _lastFrame = -1;

  public constructor(private readonly _length = HISTORY_LENGTH) {
    this._buffer = new Array<StateDiff>(_length);

    for (let i = 0; i < _length; i++) {
      const toFrame = -1 - i;
      this._buffer[this._index(toFrame)] = emptyDiff(toFrame);
    }
  }

  public get lastFrame(): number {
    return this._lastFrame;
  }

  public get oldestFrame(): number {
    return this._lastFrame - this._length + 1;
  }

  public push(diff: StateDiff): void {
    if (diff.toFrame !== this._lastFrame + 1) {
      throw new Error(`Expected frame ${this._lastFrame + 1}, got ${diff.toFrame}`);
    }

    this._lastFrame = diff.toFrame;
    this._buffer[this._index(diff.toFrame)] = diff;
  }

  public get(frame: number): StateDiff {
    if (frame < this.oldestFrame || frame > this._lastFrame) {
      throw new Error(`Frame ${frame} is outside history window`);
    }

    return this._buffer[this._index(frame)];
  }

  public pull(from: number, to: number): StateDiff {
    if (to < from) {
      throw new Error(`Invalid history range ${from}..${to}`);
    }

    if (to === from) {
      return new StateDiff({ fromFrame: from, toFrame: to });
    }

    if (to === from + 1) {
      return this.get(to);
    }

    const entities = new Map<number, EntityHistory>();

    for (let frame = from + 1; frame <= to; frame++) {
      applyDiff(entities, this.get(frame));
    }

    return forgeDiff(from, to, entities);
  }

  private _index(frame: number): number {
    return ((frame % this._length) + this._length) % this._length;
  }
}

function applyDiff(entities: Map<number, EntityHistory>, diff: StateDiff): void {
  diff.snapshots.forEach((snapshot) => {
    let entity = entities.get(snapshot.eid);

    if (entity === undefined || entity === REMOVED) {
      entity = new ArrayMap<Slot>();
      entities.set(snapshot.eid, entity);
    }

    entity.set(snapshot.type, snapshot);
  });

  diff.removed.forEach(([eid, type]) => {
    if (type === ALL_COMPONENTS) {
      entities.set(eid, REMOVED);
      return;
    }

    const entity = entities.get(eid);
    if (entity === REMOVED) {
      return;
    }

    const components = entity ?? new ArrayMap<Slot>();
    components.set(type, REMOVED);
    entities.set(eid, components);
  });
}

function forgeDiff(from: number, to: number, entities: Map<number, EntityHistory>): StateDiff {
  const snapshots: EncodedSnapshot[] = [];
  const removed: RemovedComponent[] = [];

  entities.forEach((entity, eid) => {
    if (entity === REMOVED) {
      removed.push([eid, ALL_COMPONENTS]);
      return;
    }

    entity.forEach((slot, type) => {
      if (slot === REMOVED) {
        removed.push([eid, type]);
      } else {
        snapshots.push(slot);
      }
    });
  });

  return new StateDiff({ fromFrame: from, toFrame: to, snapshots, removed });
}

function emptyDiff(toFrame: number): StateDiff {
  return new StateDiff({
    fromFrame: toFrame - 1,
    toFrame,
    snapshots: [],
    removed: [],
  });
}
