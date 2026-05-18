import { StateDiff } from "@vworlds/vecs-protocol";

export const HISTORY_LENGTH = 5;

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

  private _index(frame: number): number {
    return ((frame % this._length) + this._length) % this._length;
  }
}

function emptyDiff(toFrame: number): StateDiff {
  return new StateDiff({
    fromFrame: toFrame - 1,
    toFrame,
    snapshots: [],
    removed: [],
  });
}
