/**
 * The last `capacity` frames in which a session was sent a baseline or a delta
 * with content, which is what an optimistic delta is based on
 * (`ServerWorldOptions.redundancyFrames` is the `capacity`).
 *
 * A client's version is always a frame it was sent, so the base of a delta that
 * presumes the client's version must be one too. It is the oldest of the ring, the
 * frame sent `capacity` sends ago:
 *
 * - It is at least `capacity` frames before the one being sent, so a change
 *   travels in `capacity` consecutive frames and no more.
 * - The client holds it, or something newer, unless it lost all of the `capacity`
 *   most recent sends. Up to `capacity - 1` losses in a row cost nothing, however
 *   far apart in time the sends were. A base chosen by frame number alone does
 *   not give that when traffic is sparse: it lands on the last copy of the
 *   previous change, whose loss then reads as a gap.
 *
 * The ring is allocated when the session is created and holds the frame the
 * session started at until `capacity` frames have been sent. A session's ack is
 * never behind its starting frame, so the padding never names a base before the ack.
 *
 * Both operations are O(1) and allocate nothing.
 */
export class SentFrames {
  private readonly _frames: Float64Array;
  private _oldestSlot = 0;

  /**
   * @param capacity - How many sent frames to retain: `redundancyFrames`.
   * @param startFrame - The frame before the session's first, which stands in for the
   *   sends that have not happened yet.
   */
  public constructor(capacity: number, startFrame: number) {
    this._frames = new Float64Array(capacity).fill(startFrame);
  }

  /** The newest frame sent, or the starting frame while none has been. */
  public get newest(): number {
    return this._frames[(this._oldestSlot === 0 ? this._frames.length : this._oldestSlot) - 1];
  }

  /**
   * The frame sent `capacity` sends ago: the base of the next optimistic delta. The
   * starting frame while fewer than `capacity` frames have been sent.
   */
  public get oldest(): number {
    return this._frames[this._oldestSlot];
  }

  /** Record that a baseline or a delta with content was sent in `frame`, the newest so far. */
  public push(frame: number): void {
    this._frames[this._oldestSlot] = frame;
    this._oldestSlot = this._oldestSlot + 1 === this._frames.length ? 0 : this._oldestSlot + 1;
  }
}
