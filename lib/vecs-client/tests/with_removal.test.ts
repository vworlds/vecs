// A network removal of a component that another component on the entity brings through `With` is
// skipped by ClientWorld.apply; any other removal, and the destruction of the entity, apply as sent.

import { describe, expect, it } from "vitest";
import {
  ComponentSnapshot,
  EncodedSnapshot,
  encodeRelationshipSnapshot,
  Server2Client,
  StateDiff,
  type EntityReset,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import { Relationship, With, type ComponentClass, type EID } from "@vworlds/vecs";
import { ClientWorld } from "../src/index.js";

/** Wire type 1: a pose that a server streams, or that `Motion` brings when it sends none. */
class Pose {
  @wireType("i32")
  public x = 0;
}

/** Wire type 2: brings `Pose` through `With`, like dead reckoning's `Motion` brings `Position`. */
class Motion {
  @wireType("i32")
  public frame = 0;
}

/** Wire type 3: also brings `Pose`, and so keeps it once `Motion` is gone. */
class Hint {
  @wireType("i32")
  public value = 0;
}

/** Wire type 4: a plain component that nothing brings. */
class Plain {
  @wireType("i32")
  public value = 0;
}

/** Wire types 5 and 6: relationships, one bringing the other through `With`. */
class Holder extends Relationship {}
class Held extends Relationship {}

const POSE = 1;
const MOTION = 2;
const HINT = 3;
const PLAIN = 4;
const HOLDER = 5;
const HELD = 6;
const EID_A = 1000;
const EID_B = 1001;
const TICK_MS = 10;

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(): void {}

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

function encode(message: IEncodable | object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(message as IEncodable);
  return encoder.getBuffer();
}

function snapshot(eid: EID, wireType: number, payload: Uint8Array): EncodedSnapshot {
  return new EncodedSnapshot(
    encode(new ComponentSnapshot({ eid, wireType, payload })),
    eid,
    wireType
  );
}

function set(eid: EID, wireType: number, component: object): EncodedSnapshot {
  return snapshot(eid, wireType, encode(component));
}

function relationship<R extends Relationship>(
  eid: EID,
  wireType: number,
  Class: ComponentClass<R>,
  targets: EID[]
): EncodedSnapshot {
  const encoder = new Encoder(new Uint8Array(1024));
  encodeRelationshipSnapshot(encoder, targets, new Class());
  return snapshot(eid, wireType, encoder.getBuffer());
}

/**
 * A client that applies every diff it is sent, one frame per call, as the next frame. `apply`
 * calls `ClientWorld.apply` directly, where mutations take effect at once; `progress` runs it as
 * the world's Pull/Apply systems do, with the destruction flushed before snapshots are applied.
 */
class Client {
  public readonly world: ClientWorld;
  private readonly _socket = new MemorySocket("server");
  private _frame = 0;
  private _now = 0;

  public constructor(private readonly _mode: "apply" | "progress") {
    this.world = new ClientWorld({
      networkComponents: [Pose, Motion, Hint, Plain, Holder, Held],
      serverTickIntervalMs: TICK_MS,
    });
    this.world.component(Motion).add(With, this.world.component(Pose));
    this.world.component(Hint).add(With, this.world.component(Pose));
    this.world.component(Holder).add(With, this.world.component(Held));
    this.world.attachSocket(this._socket);
  }

  /** Send the next frame (a baseline for the first) and apply it. */
  public frame(
    snapshots: EncodedSnapshot[],
    removed: Array<[EID, number]> = [],
    resets: EntityReset[] = []
  ): void {
    const fromFrame = this._frame === 0 ? 0 : this._frame;
    this._frame++;
    this._socket.receive(
      encode(
        new Server2Client({
          diff: new StateDiff({ fromFrame, toFrame: this._frame, snapshots, removed, resets }),
        })
      )
    );
    if (this._mode === "apply") {
      this.world.apply(this._now);
    } else {
      this.world.progress(this._now, TICK_MS);
    }
    this._now += TICK_MS;
  }
}

describe.each(["apply", "progress"] as const)(
  "ClientWorld, frames applied by %s: network removal of a component another one brings through With",
  (mode) => {
    it("skips the removal while the bringer is present, and keeps the component's value", () => {
      const client = new Client(mode);
      const removed: string[] = [];
      client.world.component(Pose).on("remove", (_entity, pose) => removed.push(`x=${pose.x}`));
      client.frame([set(EID_A, POSE, Object.assign(new Pose(), { x: 7 }))]);

      // One diff: the bringer is set and the streamed component it makes redundant is removed.
      client.frame(
        [set(EID_A, MOTION, Object.assign(new Motion(), { frame: 2 }))],
        [[EID_A, POSE]]
      );

      const entity = client.world.entity(EID_A);
      expect(entity.get(Motion)).toMatchObject({ frame: 2 });
      expect(entity.get(Pose)).toMatchObject({ x: 7 });
      expect(removed).toEqual([]);
    });

    it("keeps the component whichever bringer is present, and removes it once none is", () => {
      const client = new Client(mode);
      client.frame([
        set(EID_A, POSE, Object.assign(new Pose(), { x: 3 })),
        set(EID_A, MOTION, new Motion()),
        set(EID_A, HINT, new Hint()),
      ]);

      client.frame([], [[EID_A, POSE]]);
      expect(client.world.entity(EID_A).has(Pose)).toBe(true);

      client.frame([], [[EID_A, MOTION]]);
      client.frame([], [[EID_A, POSE]]);
      expect(client.world.entity(EID_A).has(Pose)).toBe(true); // Hint still brings it

      client.frame([], [[EID_A, HINT]]);
      client.frame([], [[EID_A, POSE]]);
      expect(client.world.entity(EID_A).has(Pose)).toBe(false);
    });

    it("looks only at the entity it removes from", () => {
      const client = new Client(mode);
      client.frame([
        set(EID_A, POSE, new Pose()),
        set(EID_A, MOTION, new Motion()),
        set(EID_B, POSE, new Pose()),
      ]);

      client.frame([], [[EID_B, POSE]]);

      expect(client.world.entity(EID_A).has(Pose)).toBe(true);
      expect(client.world.entity(EID_B).has(Pose)).toBe(false);
    });

    it("removes a component that nothing brings", () => {
      const client = new Client(mode);
      client.frame([
        set(EID_A, PLAIN, Object.assign(new Plain(), { value: 4 })),
        set(EID_A, MOTION, new Motion()),
      ]);

      client.frame([], [[EID_A, PLAIN]]);

      expect(client.world.entity(EID_A).has(Plain)).toBe(false);
      expect(client.world.entity(EID_A).has(Motion)).toBe(true);
    });

    it("removes the bringer itself as sent", () => {
      const client = new Client(mode);
      client.frame([set(EID_A, POSE, new Pose()), set(EID_A, MOTION, new Motion())]);

      client.frame([], [[EID_A, MOTION]]);

      expect(client.world.entity(EID_A).has(Motion)).toBe(false);
      expect(client.world.entity(EID_A).has(Pose)).toBe(true);
    });

    it("does not apply to destroying the entity: a reset removes everything", () => {
      const client = new Client(mode);
      const removed: string[] = [];
      client.world.component(Pose).on("remove", () => removed.push("Pose"));
      client.world.component(Motion).on("remove", () => removed.push("Motion"));
      client.frame([set(EID_A, POSE, new Pose()), set(EID_A, MOTION, new Motion())]);
      const entity = client.world.entity(EID_A);

      client.frame([], [], [[EID_A, 2]]);

      expect(entity.destroyed).toBe(true);
      expect(removed.sort()).toEqual(["Motion", "Pose"]);
      expect(client.world.getEntity(EID_A)).toBeUndefined();
    });

    it("destroys With companions on a reset and keeps ones brought by the replacement's same-diff snapshot", () => {
      const client = new Client(mode);
      const removed: number[] = [];
      client.world.component(Pose).on("remove", (_entity, pose) => removed.push(pose.x));
      client.frame([
        set(EID_A, POSE, Object.assign(new Pose(), { x: 7 })),
        set(EID_A, MOTION, new Motion()),
      ]);
      const old = client.world.entity(EID_A);
      client.frame(
        [set(EID_A, MOTION, Object.assign(new Motion(), { frame: 2 }))],
        [[EID_A, POSE]],
        [[EID_A, 2]]
      );
      expect(old.destroyed).toBe(true);
      expect(removed).toEqual([7]);
      expect(client.world.entity(EID_A)).not.toBe(old);
      expect(client.world.entity(EID_A).get(Motion)?.frame).toBe(2);
      expect(client.world.entity(EID_A).get(Pose)?.x).toBe(0);
    });

    it("removes a relationship as sent, even while the relationship that brings it is present", () => {
      const client = new Client(mode);
      client.frame([
        set(EID_A, PLAIN, new Plain()),
        set(EID_B, PLAIN, new Plain()),
        relationship(EID_A, HOLDER, Holder, [EID_B]),
        relationship(EID_A, HELD, Held, [EID_B]),
      ]);
      expect(client.world.entity(EID_A).has(Held)).toBe(true);

      client.frame([], [[EID_A, HELD]]);

      expect(client.world.entity(EID_A).has(Holder)).toBe(true);
      expect(client.world.entity(EID_A).has(Held)).toBe(false);
    });
  }
);
