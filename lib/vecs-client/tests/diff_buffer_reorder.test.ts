import { expect, it } from "vitest";
import { Relationship, type EID } from "@vworlds/vecs";
import {
  ComponentSnapshot,
  EncodedSnapshot,
  encodeRelationshipSnapshot,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import {
  CLOSE_PROTOCOL_ERROR_CODE,
  ClientWorld,
  type ClientWorldDisconnectEvent,
} from "../src/index.js";
import { Diff, DiffBuffer } from "../src/diff_buffer.js";
import { History } from "../../vecs-server/src/history.js";

class ResourceContainer {
  @wireType("i32")
  public amount = 0;
}

class TowedBy extends Relationship {}

const EID_A = 1000;
const EID_B = 1001;
const EID_C = 1002;
const RESOURCE = 1;
const TOWED_BY = 2;

type Handler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  private readonly _handlers = new Map<string, Handler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: Handler): this {
    this._handlers.set(event, [...(this._handlers.get(event) ?? []), handler]);
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

function encode(value: IEncodable | object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(value as IEncodable);
  return encoder.getBuffer();
}

function snapshot(eid: EID, wireType: number, payload: Uint8Array): EncodedSnapshot {
  return new EncodedSnapshot(
    encode(new ComponentSnapshot({ eid, wireType, payload })),
    eid,
    wireType
  );
}

function resource(amount = 0): EncodedSnapshot {
  const component = new ResourceContainer();
  component.amount = amount;
  return snapshot(EID_A, RESOURCE, encode(component));
}

function tow(targets: EID[] = [EID_B]): EncodedSnapshot {
  const encoder = new Encoder(new Uint8Array(1024));
  encodeRelationshipSnapshot(encoder, targets, new TowedBy());
  return snapshot(EID_A, TOWED_BY, encoder.getBuffer());
}

function client(id: string): { world: ClientWorld; socket: MemorySocket } {
  const world = new ClientWorld({ networkComponents: [ResourceContainer, TowedBy] });
  const socket = new MemorySocket(id);
  world.attachSocket(socket);
  return { world, socket };
}

function receive(socket: MemorySocket, diff: StateDiff, optimistic = false): void {
  socket.receive(encode(new Server2Client({ diff, optimistic })));
}

it.each([
  ["apply", 1, 6, 3, 4],
  ["progress", 1, 6, 3, 4],
  ["apply", 1, 5, 2, 3],
  ["progress", 1, 5, 2, 3],
  ["apply", 2, 6, 3, 4],
  ["progress", 2, 6, 3, 4],
  ["apply", 2, 5, 3, 4],
  ["progress", 2, 5, 3, 4],
] as const)(
  "discards a covered optimistic delta through %s(): baseline %i, fallback %i, late %i -> %i",
  (mode, first, latest, from, to) => {
    const { world, socket } = client(`covered-${mode}`);
    const disconnects: unknown[] = [];
    world.events.on("disconnect", (notice) => disconnects.push(notice));
    try {
      receive(
        socket,
        new StateDiff({ fromFrame: 0, toFrame: first, snapshots: [resource(first), tow()] })
      );
      world.send(); // Ack receipt without rendering: slot zero still ends at first.
      receive(
        socket,
        new StateDiff({
          fromFrame: first,
          toFrame: latest,
          snapshots: [resource(latest)],
          removed: [[EID_A, TOWED_BY]],
        })
      );
      // A redundancy send based on a lost state frame, before the fallback.
      // The exact 1 -> 6 example collapses fully, so the late diff is below
      // base 6. Partial compaction cases land at slot zero or in a later slot
      // whose gapped delta would otherwise fail when the prefix is compacted.
      receive(
        socket,
        new StateDiff({ fromFrame: from, toFrame: to, snapshots: [resource(to), tow()] }),
        true
      );
      expect(disconnects).toEqual([]);
      for (const now of [0, 1000]) {
        if (mode === "apply") {
          world.apply(now);
        } else {
          world.progress(now, 16);
        }
      }
      expect(disconnects).toEqual([]);
      expect(world.getEntity(EID_A)?.get(ResourceContainer)?.amount).toBe(latest);
      expect(world.getEntity(EID_A)?.has(TowedBy)).toBe(false);
      expect(world.renderFrame).toBe(latest);
    } finally {
      world.dispose();
    }
  }
);

it("retains the slot base during a pull before the folded first diff is due", () => {
  const buffer = new DiffBuffer(3, 10);
  buffer.push(new Diff(0, 1));
  buffer.pull(0);
  buffer.pull(100); // Empty pull delays the next render until 130.
  buffer.push(new Diff(1, 2));
  buffer.push(new Diff(2, 6)); // Base 4, but the folded first diff still ends at 2.
  expect(buffer.pull(101).to).toBe(1);
  buffer.push(new Diff(1, 4));
  buffer.push(new Diff(6, 7));
  expect(buffer.pull(200).to).toBe(7);
  expect(buffer.version).toBe(7);
});

it("indexes incoming frames correctly after partial compaction of a larger bucket", () => {
  const buffer = new DiffBuffer(5, 10);
  buffer.push(new Diff(0, 1));
  buffer.push(new Diff(1, 7)); // Shift 2, leaving the incoming diff in slot 4.
  buffer.push(new Diff(1, 6));
  buffer.push(new Diff(7, 8));
  expect(buffer.pull(0).to).toBe(1);
  expect(buffer.pull(100).to).toBe(8);
  expect(buffer.version).toBe(8);
});

it("#244: preserves re-entry when exit and re-entry are applied in one catch-up", () => {
  const { world, socket } = client("issue-244");
  try {
    receive(socket, new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [resource(), tow()] }));
    world.apply(0);
    world.apply(1000);
    expect(world.getEntity(EID_A)?.target(TowedBy)?.eid).toBe(EID_B);

    receive(socket, new StateDiff({ fromFrame: 1, toFrame: 2, resets: [[EID_A, 2]] }));
    receive(socket, new StateDiff({ fromFrame: 2, toFrame: 3, snapshots: [resource()] }));
    world.apply(2000);

    expect(world.getEntity(EID_A)?.has(ResourceContainer)).toBe(true);
    expect(world.getEntity(EID_A)?.has(TowedBy)).toBe(false);
  } finally {
    world.dispose();
  }
});

it("#245: clears the old tow edge when history folds a lost exit with untowed re-entry", () => {
  const { world, socket } = client("issue-245");
  try {
    receive(socket, new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [resource(), tow()] }));
    world.apply(0);
    world.apply(1000);
    expect(world.getEntity(EID_A)?.target(TowedBy)?.eid).toBe(EID_B);

    const history = new History(64, 1);
    history.push(new StateDiff({ fromFrame: 1, toFrame: 2, resets: [[EID_A, 2]] }));
    history.push(new StateDiff({ fromFrame: 2, toFrame: 3, snapshots: [resource()] }));
    receive(socket, history.pull(1, 3));
    world.apply(2000);

    expect(world.getEntity(EID_A)?.has(ResourceContainer)).toBe(true);
    expect(world.getEntity(EID_A)?.target(TowedBy)?.eid).toBeUndefined();
  } finally {
    world.dispose();
  }
});

it.each(["zero targets", "old duplicate", "towed re-entry"] as const)(
  "handles %s after history folding without retaining the old target",
  (scenario) => {
    const { world, socket } = client(`relationship-frames-${scenario}`);
    const disconnects: Array<ClientWorldDisconnectEvent | undefined> = [];
    world.events.on("disconnect", (notice) => disconnects.push(notice));
    const cargo = resource();
    const baseline = new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [cargo, tow()] });
    try {
      receive(socket, baseline);
      world.apply(0);
      world.apply(1000);
      expect(world.getEntity(EID_A)?.target(TowedBy)?.eid).toBe(EID_B);

      const history = new History(64, 1);
      history.push(
        new StateDiff({
          fromFrame: 1,
          toFrame: 2,
          snapshots: scenario === "zero targets" ? [tow([])] : [],
          removed: scenario === "old duplicate" ? [[EID_A, TOWED_BY]] : [],
          resets: scenario === "towed re-entry" ? [[EID_A, 2]] : [],
        })
      );
      history.push(
        new StateDiff({
          fromFrame: 2,
          toFrame: 3,
          snapshots: scenario === "towed re-entry" ? [cargo, tow([EID_C])] : [cargo],
        })
      );
      receive(socket, history.pull(1, 3));
      world.apply(2000);

      if (scenario === "zero targets") {
        // Last-edge removal must be a component tombstone, not an empty snapshot.
        expect(disconnects).toHaveLength(1);
        expect(disconnects[0]?.code).toBe(CLOSE_PROTOCOL_ERROR_CODE);
        expect(disconnects[0]?.reason).toContain("must contain at least one target");
        return;
      }

      expect(disconnects).toEqual([]);
      expect(world.getEntity(EID_A)?.has(ResourceContainer)).toBe(true);
      expect(
        world
          .getEntity(EID_A)
          ?.targets(TowedBy)
          .map((target) => target.eid)
      ).toEqual(scenario === "towed re-entry" ? [EID_C] : []);
      expect(world.renderFrame).toBe(3);

      if (scenario === "towed re-entry") {
        return;
      }

      receive(socket, baseline);
      world.apply(3000);
      expect(disconnects).toEqual([]);
      expect(world.getEntity(EID_A)?.has(ResourceContainer)).toBe(true);
      expect(
        world
          .getEntity(EID_A)
          ?.targets(TowedBy)
          .map((target) => target.eid)
      ).toEqual([]);
      expect(world.renderFrame).toBe(3);
    } finally {
      world.dispose();
    }
  }
);

it("#246: accepts a delayed older delta between newer ack-based deltas", () => {
  const { world, socket } = client("issue-246-order");
  const disconnects: unknown[] = [];
  world.events.on("disconnect", (notice) => disconnects.push(notice));
  const cargo = resource();
  try {
    receive(socket, new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [cargo] }));
    world.apply(0);
    world.apply(1000);
    receive(socket, new StateDiff({ fromFrame: 1, toFrame: 2, snapshots: [cargo] }));
    receive(socket, new StateDiff({ fromFrame: 2, toFrame: 6, snapshots: [cargo] }));
    receive(socket, new StateDiff({ fromFrame: 1, toFrame: 4, snapshots: [cargo] }));
    receive(socket, new StateDiff({ fromFrame: 6, toFrame: 7, snapshots: [cargo] }));

    expect(disconnects).toEqual([]);
    world.apply(2000);
    expect(world.getEntity(EID_A)?.has(ResourceContainer)).toBe(true);
  } finally {
    world.dispose();
  }
});

it("#246 comment: does not resurrect a removed tow edge from a delayed older delta", () => {
  const { world, socket } = client("issue-246-tow");
  const cargo = resource();
  const relationship = tow();
  try {
    receive(socket, new StateDiff({ fromFrame: 0, toFrame: 1, snapshots: [cargo, relationship] }));
    // Receipt is acknowledged independently of rendering; retain all three diffs in the buffer.
    world.send();
    receive(
      socket,
      new StateDiff({ fromFrame: 1, toFrame: 5, snapshots: [cargo], removed: [[EID_A, TOWED_BY]] })
    );
    receive(socket, new StateDiff({ fromFrame: 1, toFrame: 4, snapshots: [cargo, relationship] }));
    world.apply(0);
    world.apply(1000);

    expect(world.getEntity(EID_A)?.has(ResourceContainer)).toBe(true);
    expect(world.getEntity(EID_A)?.target(TowedBy)?.eid).toBeUndefined();
  } finally {
    world.dispose();
  }
});

it("matches in-order applied state for every arrival permutation with one duplicate", () => {
  // The server has seen ack 1, then ack 2. All deltas are valid against the
  // received baseline at 2, except the optimistic redundancy delta from lost
  // state frame 3. That delta is held if early and covered if late. Frame gaps force
  // partial and full compaction; removal at 5 is superseded by re-addition at 6.
  const deltas = [
    new StateDiff({ fromFrame: 1, toFrame: 4, snapshots: [resource(4), tow()] }),
    new StateDiff({
      fromFrame: 1,
      toFrame: 5,
      removed: [
        [EID_A, RESOURCE],
        [EID_A, TOWED_BY],
      ],
    }),
    new StateDiff({
      fromFrame: 2,
      toFrame: 6,
      snapshots: [resource(6)],
      removed: [[EID_A, TOWED_BY]],
    }),
    new StateDiff({
      fromFrame: 2,
      toFrame: 10,
      snapshots: [resource(10)],
      removed: [[EID_A, TOWED_BY]],
    }),
    new StateDiff({ fromFrame: 3, toFrame: 4, snapshots: [resource(4), tow()] }),
  ];
  function applyOrder(order: readonly number[]): unknown {
    const { world, socket } = client("permutation");
    const disconnects: unknown[] = [];
    world.events.on("disconnect", (notice) => disconnects.push(notice));
    try {
      receive(socket, new StateDiff({ fromFrame: 0, toFrame: 2, snapshots: [resource(2), tow()] }));
      world.send(); // Keep the baseline buffered so late 3 -> 4 can hit folded slot zero.
      for (const index of order) {
        receive(socket, deltas[index], index === 4);
      }
      world.apply(0);
      world.apply(2000);
      expect(disconnects, `arrival order ${order.join(",")}`).toEqual([]);
      return {
        amount: world.getEntity(EID_A)?.get(ResourceContainer)?.amount,
        towedBy: world.getEntity(EID_A)?.target(TowedBy)?.eid,
        frame: world.renderFrame,
      };
    } finally {
      world.dispose();
    }
  }
  const expected = applyOrder([0, 4, 1, 2, 3]);
  expect(expected).toEqual({ amount: 10, towedBy: undefined, frame: 10 });
  let count = 0;
  function enumerate(prefix: number[], remaining: number[]): void {
    if (remaining.length === 0) {
      expect(applyOrder(prefix), `arrival order ${prefix.join(",")}`).toEqual(expected);
      count++;
      return;
    }
    const selected = new Set<number>();
    for (let i = 0; i < remaining.length; i++) {
      if (selected.has(remaining[i])) {
        continue;
      }
      selected.add(remaining[i]);
      enumerate(
        [...prefix, remaining[i]],
        remaining.filter((_, j) => j !== i)
      );
    }
  }
  // Enumerate all 6!/2! distinct arrivals, including the duplicate old snapshot delta.
  enumerate([], [0, 1, 2, 3, 4, 0]);
  expect(count).toBe(360);
});
