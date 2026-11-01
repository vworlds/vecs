import { describe, expect, it } from "vitest";
import { Module, World } from "../src/index.js";

class Settings {
  public value = 0;
}
class Sprite {}

describe("Module.dispose", () => {
  it("runs once per module, last installed first, after application hooks and before infrastructure hooks", () => {
    const log: string[] = [];
    class Inner extends Module {
      public init(): void {}
      public override dispose(): void {
        log.push(`dispose ${this.constructor.name}`);
      }
    }
    class Outer extends Module {
      public init(): void {
        this.world.component(Settings).on("remove", () => log.push("remove Settings"));
        this.world.set(Settings, { value: 1 });
        this.world.module(Inner);
      }
      public override dispose(): void {
        // Infrastructure is still intact: the module's singleton data is readable.
        log.push(`dispose ${this.constructor.name} ${this.world.get(Settings)?.value}`);
      }
    }
    class Later extends Module {
      public init(): void {}
      public override dispose(): void {
        log.push(`dispose ${this.constructor.name}`);
      }
    }
    const world = new World();
    world.component(Sprite).on("remove", () => log.push("remove Sprite"));
    world.module(Outer);
    world.module(Later);
    world.entity().add(Sprite);

    world.dispose();
    world.dispose();

    expect(log).toEqual([
      "remove Sprite",
      "dispose Later",
      "dispose Inner",
      "dispose Outer 1",
      "remove Settings",
    ]);
    expect(world.entities.size).toBe(0);
  });

  it("skips modules without dispose and modules destroyed before disposal", () => {
    const calls: string[] = [];
    class Plain extends Module {
      public init(): void {}
    }
    class Gone extends Module {
      public init(): void {}
      public override dispose(): void {
        calls.push("Gone");
      }
    }
    class Kept extends Module {
      public init(): void {}
      public override dispose(): void {
        calls.push("Kept");
      }
    }
    const world = new World();
    world.module(Plain);
    world.module(Kept);
    world.module(Gone).destroy();

    world.dispose();

    expect(calls).toEqual(["Kept"]);
  });

  it("propagates an error thrown by dispose", () => {
    class Faulty extends Module {
      public init(): void {}
      public override dispose(): void {
        throw new Error("release failed");
      }
    }
    const world = new World();
    world.module(Faulty);

    expect(() => world.dispose()).toThrow("release failed");
  });
});
