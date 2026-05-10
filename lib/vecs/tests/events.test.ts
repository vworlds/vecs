import { describe, it, expect, vi } from "vitest";
import { Events } from "../src/util/events.js";

type Map = {
  hello(name: string): void;
  count(n: number): void;
};

describe("Events", () => {
  it("calls listeners with their typed args", () => {
    const e = new Events<Map>();
    const greet = vi.fn();
    e.on("hello", greet);
    e.emit("hello", "world");
    expect(greet).toHaveBeenCalledWith("world");
  });

  it("once fires only on the first emit", () => {
    const e = new Events<Map>();
    const cb = vi.fn();
    e.once("count", cb);
    e.emit("count", 1);
    e.emit("count", 2);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it("off / removeListener detaches a single listener", () => {
    const e = new Events<Map>();
    const cb = vi.fn();
    e.on("hello", cb);
    e.off("hello", cb);
    e.emit("hello", "x");
    expect(cb).not.toHaveBeenCalled();
  });

  it("removeAllListeners detaches every handler", () => {
    const e = new Events<Map>();
    const a = vi.fn();
    const b = vi.fn();
    e.on("hello", a);
    e.on("hello", b);
    e.removeAllListeners("hello");
    e.emit("hello", "x");
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});
