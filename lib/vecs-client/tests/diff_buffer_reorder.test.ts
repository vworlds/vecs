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
import { ClientWorld } from "../src/index.js";
import { Diff, DiffBuffer } from "../src/diff_buffer.js";
import { History } from "../../vecs-server/src/history.js";

class ResourceContainer {
  @wireType("i32")
  public amount = 0;
}

class TowedBy extends Relationship {}

const EID_A = 1000;
const EID_B = 1001;
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

function tow(): EncodedSnapshot {
  const encoder = new Encoder(new Uint8Array(1024));
  encodeRelationshipSnapshot(encoder, [EID_B], new TowedBy());
  return snapshot(EID_A, TOWED_BY, encoder.getBuffer());
}

function client(id: string): { world: ClientWorld; socket: MemorySocket } {
  const world = new ClientWorld({ networkComponents: [ResourceContainer, TowedBy] });
  const socket = new MemorySocket(id);
  world.attachSocket(socket);
  return { world, socket };
}

function receive(socket: MemorySocket, diff: StateDiff): void {
  socket.receive(encode(new Server2Client({ diff })));
}

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
  // received baseline at 2, even when delivered out of order. Frame gaps force
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
  ];
  function applyOrder(order: readonly number[]): unknown {
    const { world, socket } = client("permutation");
    const disconnects: unknown[] = [];
    world.events.on("disconnect", (notice) => disconnects.push(notice));
    try {
      receive(socket, new StateDiff({ fromFrame: 0, toFrame: 2, snapshots: [resource(2), tow()] }));
      world.apply(0);
      world.apply(1000);
      for (const index of order) {
        receive(socket, deltas[index]);
      }
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
  const expected = applyOrder([0, 1, 2, 3]);
  expect(expected).toEqual({ amount: 10, towedBy: undefined, frame: 10 });
  let count = 0;
  function enumerate(prefix: number[], remaining: number[]): void {
    if (remaining.length === 0) {
      expect(applyOrder(prefix), `arrival order ${prefix.join(",")}`).toEqual(expected);
      count++;
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      enumerate(
        [...prefix, remaining[i]],
        remaining.filter((_, j) => j !== i)
      );
    }
  }
  // Enumerate all 5! arrivals, including the duplicate old snapshot delta.
  enumerate([], [0, 1, 2, 3, 0]);
  expect(count).toBe(120);
});
