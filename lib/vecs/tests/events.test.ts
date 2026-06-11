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

  it("emit returns true when there is at least one listener, else false", () => {
    const e = new Events<Map>();
    expect(e.emit("hello", "x")).toBe(false);
    e.on("hello", vi.fn());
    expect(e.emit("hello", "x")).toBe(true);
  });

  it("invokes listeners with the given context as `this`", () => {
    const e = new Events<Map>();
    const ctx = { value: "ctx" };
    let seen: unknown;
    e.on(
      "hello",
      function (this: typeof ctx) {
        seen = this.value;
      },
      ctx
    );
    e.emit("hello", "x");
    expect(seen).toBe("ctx");
  });

  it("a listener added during emit is not invoked by that same emit", () => {
    const e = new Events<Map>();
    const second = vi.fn();
    const first = vi.fn(() => e.on("hello", second));
    e.on("hello", first);
    e.emit("hello", "x");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    e.emit("hello", "y");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("once fires exactly once even when emit is re-entered from within the listener", () => {
    const e = new Events<Map>();
    const cb = vi.fn(() => e.emit("count", 2));
    e.once("count", cb);
    e.emit("count", 1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it("off removes a once listener before it fires", () => {
    const e = new Events<Map>();
    const cb = vi.fn();
    e.once("count", cb);
    e.off("count", cb);
    e.emit("count", 1);
    expect(cb).not.toHaveBeenCalled();
  });

  it("listenerCount and eventNames reflect registered listeners", () => {
    const e = new Events<Map>();
    expect(e.listenerCount("hello")).toBe(0);
    expect(e.eventNames()).toEqual([]);

    e.on("hello", vi.fn());
    e.on("hello", vi.fn());
    e.on("count", vi.fn());

    expect(e.listenerCount("hello")).toBe(2);
    expect(e.listenerCount("count")).toBe(1);
    expect(e.eventNames().sort()).toEqual(["count", "hello"]);
  });
});
