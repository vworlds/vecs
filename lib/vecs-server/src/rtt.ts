/**
 * Weight of each new sample in the smoothed round-trip time, as in TCP
 * (RFC 6298's `alpha`): the estimate moves an eighth of the way to every sample.
 */
const SRTT_GAIN = 1 / 8;

/**
 * How many recent frames the estimator remembers the send time of. A power of
 * two, so a frame's slot is `frame & RING_MASK`.
 *
 * It does not follow the history window: the round trip has to stay measurable
 * when it is longer than the window, which is exactly when a baseline has to wait
 * for it. 256 frames cover an ack lag of 8.5 s at 30 Hz, 4.3 s at 60 Hz and 2.1 s
 * at 120 Hz.
 */
const RING_SIZE = 256;
const RING_MASK = RING_SIZE - 1;

/**
 * Per-session estimate of how long the server waits for the ack of a frame.
 *
 * The server stamps every frame it sends with the time it sent it, in a ring of
 * the last 256 frames. When an ack arrives that moves the session's acked frame
 * forward, the time since that frame was sent is one sample, and the estimate is
 * an exponentially weighted moving average of the samples: the first sample
 * becomes the estimate, and each later one moves it `1/8` of the way.
 *
 * A sample covers the whole loop: the frame travelling to the client, the wait
 * for the client's next ack tick (up to one `ackIntervalMs`), and the ack
 * travelling back. That is what the server needs to know — how late an ack for
 * a frame can reasonably be — so no attempt is made to separate the parts.
 *
 * Both operations are O(1).
 */
export class RttEstimator {
  private readonly _frames = new Float64Array(RING_SIZE).fill(-1);
  private readonly _sentAtMs = new Float64Array(RING_SIZE);
  private _srttMs: number | undefined = undefined;

  /**
   * The smoothed round-trip time in milliseconds, or `undefined` before the
   * first sample.
   */
  public get srttMs(): number | undefined {
    return this._srttMs;
  }

  /** Remember that `frame` was sent at `nowMs`. */
  public recordSend(frame: number, nowMs: number): void {
    const slot = frame & RING_MASK;
    this._frames[slot] = frame;
    this._sentAtMs[slot] = nowMs;
  }

  /**
   * Take the sample an ack for `frame` yields at `nowMs`.
   *
   * Call it once per ack that advances the session's acked frame. A frame that
   * was never recorded, or whose slot a newer frame has since reused, yields no
   * sample and leaves the estimate unchanged.
   */
  public recordAck(frame: number, nowMs: number): void {
    const slot = frame & RING_MASK;
    if (this._frames[slot] !== frame) {
      return;
    }
    const sampleMs = Math.max(0, nowMs - this._sentAtMs[slot]);
    this._srttMs =
      this._srttMs === undefined ? sampleMs : this._srttMs + (sampleMs - this._srttMs) * SRTT_GAIN;
  }
}
