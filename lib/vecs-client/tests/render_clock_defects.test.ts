import { CidLayout } from "@vworlds/vecs-protocol";
import { expect, it } from "vitest";
import { Diff, DiffBuffer } from "../src/diff_buffer.js";

const testCid = new CidLayout(256);

// #271: the fourth arrival folds away the first resumed frame before its first applying pull.
it.fails(
  "applies the first resumed frame before folding it into the following frame (#271)",
  () => {
    const buffer = new DiffBuffer(testCid, 3, 1000 / 30);
    buffer.pull(0); // refill deadline is 100 ms
    buffer.push(new Diff(testCid, 0, 120)); // packets arrive just after the dry pull
    buffer.push(new Diff(testCid, 120, 121));
    buffer.push(new Diff(testCid, 121, 122));
    const early = buffer.pull(90); // decisively before the current deadline; no equality dependency
    const earlyFrame = buffer.renderFrame;
    buffer.push(new Diff(testCid, 122, 123)); // fourth arrival beats the next render
    const later = buffer.pull(110);
    expect(early.to || later.to).toBe(120);
    expect(early.to ? earlyFrame : buffer.renderFrame).toBeLessThan(121);
  }
);
