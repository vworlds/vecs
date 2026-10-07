import { describe, expect, it } from "vitest";
import { RttEstimator } from "../src/rtt.js";

/** How many recent frames an estimator remembers the send time of. */
const RING_FRAMES = 256;

describe("RttEstimator", () => {
  it("has no estimate before the first sample", () => {
    const rtt = new RttEstimator();

    expect(rtt.srttMs).toBeUndefined();
  });

  it("takes the first sample as the estimate", () => {
    const rtt = new RttEstimator();
    rtt.recordSend(1, 1000);

    rtt.recordAck(1, 1230);

    expect(rtt.srttMs).toBe(230);
  });

  it("moves an eighth of the way to each later sample", () => {
    const rtt = new RttEstimator();
    rtt.recordSend(1, 0);
    rtt.recordAck(1, 100);
    rtt.recordSend(2, 40);
    rtt.recordSend(3, 80);

    rtt.recordAck(2, 40 + 180);
    expect(rtt.srttMs).toBe(110);

    rtt.recordAck(3, 80 + 20);
    expect(rtt.srttMs).toBeCloseTo(110 + (20 - 110) / 8, 10);
  });

  it("converges on a steady round trip", () => {
    const rtt = new RttEstimator();
    rtt.recordSend(1, 0);
    rtt.recordAck(1, 500);

    for (let frame = 2; frame <= 200; frame++) {
      rtt.recordSend(frame, frame * 33);
      rtt.recordAck(frame, frame * 33 + 220);
    }

    expect(rtt.srttMs).toBeCloseTo(220, 1);
  });

  it("measures a frame from when it was sent, not from the newest send", () => {
    const rtt = new RttEstimator();
    rtt.recordSend(1, 0);
    rtt.recordSend(2, 33);
    rtt.recordSend(3, 66);

    rtt.recordAck(1, 250);

    expect(rtt.srttMs).toBe(250);
  });

  it("ignores an ack for a frame that was never recorded", () => {
    const rtt = new RttEstimator();
    rtt.recordSend(1, 0);

    rtt.recordAck(2, 100);

    expect(rtt.srttMs).toBeUndefined();
  });

  it("remembers the last 256 frames, whatever the history window", () => {
    const rtt = new RttEstimator();
    for (let frame = 1000; frame < 1000 + RING_FRAMES; frame++) {
      rtt.recordSend(frame, frame);
    }

    // The oldest frame still in the ring is 255 frames behind the newest.
    rtt.recordAck(1000, 5000);

    expect(rtt.srttMs).toBe(4000);
  });

  it("measures an ack that is hundreds of frames late, which a history window of 64 could not", () => {
    const rtt = new RttEstimator();
    rtt.recordSend(1, 0);
    for (let frame = 2; frame <= 200; frame++) {
      rtt.recordSend(frame, (frame - 1) * 33);
    }

    // The ack of frame 1 arrives when frame 200 has been sent: 199 frames, 6.5 s, later.
    rtt.recordAck(1, 6567);

    expect(rtt.srttMs).toBe(6567);
  });

  it("ignores an ack for a frame older than the ring remembers", () => {
    const rtt = new RttEstimator();
    for (let frame = 1; frame <= RING_FRAMES + 3; frame++) {
      rtt.recordSend(frame, frame * 10);
    }

    // Frame 1 shared a slot with frame 257, which replaced it.
    rtt.recordAck(1, 100_000);
    expect(rtt.srttMs).toBeUndefined();

    // Frame 4 is still the newest frame in its slot.
    rtt.recordAck(4, 100_000);
    expect(rtt.srttMs).toBe(100_000 - 40);
  });

  it("keeps the estimate when an ack yields no sample", () => {
    const rtt = new RttEstimator();
    rtt.recordSend(1, 0);
    rtt.recordAck(1, 80);

    rtt.recordAck(9, 500);

    expect(rtt.srttMs).toBe(80);
  });

  it("never reports a negative round trip", () => {
    const rtt = new RttEstimator();
    rtt.recordSend(1, 100);

    rtt.recordAck(1, 90);

    expect(rtt.srttMs).toBe(0);
  });

  it("indexes frame numbers past 2^32 by their low bits, so a server that runs for years still measures", () => {
    const rtt = new RttEstimator();
    const frame = 2 ** 32 + 2 ** 20 + 37;
    rtt.recordSend(frame, 10);
    rtt.recordSend(frame + 1, 20);

    rtt.recordAck(frame + 1, 250);

    expect(rtt.srttMs).toBe(230);
  });
});
