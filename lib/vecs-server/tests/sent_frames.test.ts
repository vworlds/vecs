import { describe, expect, it } from "vitest";
import { SentFrames } from "../src/sent_frames.js";

describe("SentFrames", () => {
  it("holds the starting frame until it has been pushed as many sends as its capacity", () => {
    const sent = new SentFrames(3, 40);

    expect([sent.oldest, sent.newest]).toEqual([40, 40]);
    sent.push(41);
    expect([sent.oldest, sent.newest]).toEqual([40, 41]);
    sent.push(45);
    expect([sent.oldest, sent.newest]).toEqual([40, 45]);
  });

  it("names the state frame of the send `capacity` sends ago as the oldest, once that many have been sent", () => {
    const sent = new SentFrames(3, 0);
    [10, 11, 15].forEach((frame) => sent.push(frame));

    expect([sent.oldest, sent.newest]).toEqual([10, 15]);
    sent.push(16);
    expect([sent.oldest, sent.newest]).toEqual([11, 16]);
    sent.push(30);
    expect([sent.oldest, sent.newest]).toEqual([15, 30]);
  });

  it("keeps a state frame that several sends share, as the repeats of a change do", () => {
    // R = 2: a change in frame 7 is sent in 7 and 8, so both name state frame 7; the next change,
    // in frame 11, is sent in 11 and 12.
    const sent = new SentFrames(2, 1);

    sent.push(7);
    expect([sent.oldest, sent.newest]).toEqual([1, 7]);
    sent.push(7);
    expect([sent.oldest, sent.newest]).toEqual([7, 7]);
    sent.push(11);
    expect([sent.oldest, sent.newest]).toEqual([7, 11]);
    sent.push(11);
    expect([sent.oldest, sent.newest]).toEqual([11, 11]);
  });

  it("keeps a capacity of one: the oldest is the newest", () => {
    const sent = new SentFrames(1, 7);
    expect([sent.oldest, sent.newest]).toEqual([7, 7]);

    sent.push(8);
    sent.push(20);

    expect([sent.oldest, sent.newest]).toEqual([20, 20]);
  });

  it("wraps around over many sends, always reporting the state frame of the send `capacity` sends ago", () => {
    const capacity = 5;
    const sent = new SentFrames(capacity, 0);
    const frames: number[] = [];
    for (let i = 1; i <= 100; i++) {
      const frame = i * 3;
      sent.push(frame);
      frames.push(frame);

      expect(sent.newest).toBe(frame);
      expect(sent.oldest).toBe(frames.length >= capacity ? frames[frames.length - capacity] : 0);
    }
  });
});
