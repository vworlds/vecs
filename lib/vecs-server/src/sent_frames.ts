/**
 * The state frames of the last `capacity` sends to a session, which is what an
 * optimistic delta is based on (`ServerWorldOptions.redundancyFrames` is the
 * `capacity`).
 *
 * A send is a baseline, a delta with content or a keepalive. Its **state frame** is
 * the newest frame at which the session's replicated state had changed as of that
 * send (`History.lastContentFrame`): the send's own frame when it carries a new
 * change, and the earlier frame of the change when it only carries it again, as the
 * later copies of a change do, or carries nothing, as a keepalive. The session's
 * state is the same at every frame from the state frame to the send, so a delta
 * that starts at the state frame holds exactly what one starting at the send would.
 *
 * The base of an optimistic delta is the oldest of the ring, the state frame of the
 * send `capacity` sends ago:
 *
 * - A change is carried by `capacity` consecutive sends: its own, and the next
 *   `capacity - 1`, whose bases still lie before it. The send after those starts at
 *   the change and no longer carries it.
 * - The client holds the base, or something newer, unless it lost all of the
 *   `capacity` most recent sends. Up to `capacity - 1` losses in a row cost nothing,
 *   however far apart in time the sends were.
 * - A lost send that carried nothing the client lacked, a keepalive or a repeat of a
 *   change it already holds, costs nothing at all: it names the same state frame as
 *   the send before it, so it never moves the base past what the client holds. A base
 *   chosen from the frames sent would land on it, and the loss would read as a gap
 *   though nothing was missing.
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
   * @param capacity - How many sends to retain: `redundancyFrames`.
   * @param startFrame - The frame before the session's first, which stands in for the
   *   sends that have not happened yet.
   */
  public constructor(capacity: number, startFrame: number) {
    this._frames = new Float64Array(capacity).fill(startFrame);
  }

  /** The state frame of the newest send, or the starting frame while none has been. */
  public get newest(): number {
    return this._frames[(this._oldestSlot === 0 ? this._frames.length : this._oldestSlot) - 1];
  }

  /**
   * The state frame of the send `capacity` sends ago: the base of the next optimistic
   * delta. The starting frame while fewer than `capacity` sends have happened.
   */
  public get oldest(): number {
    return this._frames[this._oldestSlot];
  }

  /**
   * Record a send, the newest so far, whose state frame is `stateFrame`: the frame at
   * which the session's state last changed, as of this send.
   */
  public push(stateFrame: number): void {
    this._frames[this._oldestSlot] = stateFrame;
    this._oldestSlot = this._oldestSlot + 1 === this._frames.length ? 0 : this._oldestSlot + 1;
  }
}
