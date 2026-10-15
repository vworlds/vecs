import { describe, expect, it } from "vitest";
import {
  ComponentSnapshot,
  EncodedSnapshot,
  RPC_CLOSED_CODE,
  Server2Client,
  StateDiff,
  type RemovedComponent,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import type { EID } from "@vworlds/vecs";
import {
  CLOSE_PROTOCOL_ERROR_CODE,
  ClientWorld,
  type ClientWorldDisconnectEvent,
} from "../src/index.js";

// These tests use [Position, Velocity] (2 components, localComponentMin = 4), so
// wire type 3 fits in a packed component id but names no registered component.
// Separate file so the global localComponentMin doesn't conflict with the
// existing client tests that use [Position] (localComponentMin = 2).

const UNREGISTERED_WIRE_TYPE = 3;

class Position {
  @wireType("i32")
  public x = 0;

  @wireType("i32")
  public y = 0;
}

class Velocity {
  @wireType("i32")
  public dx = 0;
}

/** A client-local effect, never sent over the wire. */
class Spark {}

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public closeCalls = 0;
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(_data: Uint8Array): void {}

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this.closeCalls += 1;
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

function encodeComponent(component: object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(1024));
  encoder.write(component);
  return encoder.getBuffer();
}

function encodeMessage(message: IEncodable, size = 64 * 1024): Uint8Array {
  const encoder = new Encoder(new Uint8Array(size));
  encoder.write(message);
  return encoder.getBuffer();
}

function makeSnapshot(eid: EID, wireType: number, payload: Uint8Array): EncodedSnapshot {
  return new EncodedSnapshot(
    encodeMessage(new ComponentSnapshot({ eid, wireType, payload })),
    eid,
    wireType
  );
}

function posSnapshot(eid: EID, x: number, y: number): EncodedSnapshot {
  const position = new Position();
  position.x = x;
  position.y = y;
  return makeSnapshot(eid, 1, encodeComponent(position));
}

/** A snapshot of a component a newer server knows and this client does not. */
function unregisteredSnapshot(eid: EID): EncodedSnapshot {
  return makeSnapshot(eid, UNREGISTERED_WIRE_TYPE, new Uint8Array());
}

/** A snapshot whose envelope cannot be read, inside a frame that still decodes around it. */
function malformedEnvelope(eid: EID): EncodedSnapshot {
  // An unterminated varint where the packed component id should be.
  return new EncodedSnapshot(Uint8Array.of(0xff), eid, 1);
}

function diffFrame(
  fromFrame: number,
  toFrame: number,
  snapshots: EncodedSnapshot[] = [],
  removed: RemovedComponent[] = []
): Uint8Array {
  return encodeMessage(
    new Server2Client({ diff: new StateDiff({ fromFrame, toFrame, snapshots, removed }) })
  );
}

/** A client attached to an in-memory socket, recording every `disconnect` payload. */
function connect() {
  const client = new ClientWorld({
    networkComponents: [Position, Velocity],
    serverTickIntervalMs: 10,
  });
  const socket = new MemorySocket("server");
  const disconnects: Array<ClientWorldDisconnectEvent | undefined> = [];
  client.events.on("disconnect", (event) => disconnects.push(event));
  client.attachSocket(socket);
  return { client, socket, disconnects };
}

const PROTOCOL_ERROR = /^protocol error: .+/;

/** Frames the client cannot decode, each failing in a different way. */
const UNDECODABLE_FRAMES = [
  {
    name: "random bytes",
    // 0xde is no field tag the protocol defines.
    frame: () => Uint8Array.of(0xde, 0xad, 0xbe, 0xef),
    reason: /^protocol error: Invalid Server2Client field tag 222$/,
  },
  {
    name: "a truncated frame",
    frame: () => {
      const whole = diffFrame(0, 1, [posSnapshot(1000, 1, 1)]);
      return whole.slice(0, whole.length - 3);
    },
    reason: PROTOCOL_ERROR,
  },
  {
    name: "an unknown field tag",
    frame: () => Uint8Array.of(...diffFrame(0, 1), 99),
    reason: /^protocol error: Invalid Server2Client field tag 99$/,
  },
];

describe("ClientWorld frames it cannot decode", () => {
  it.each(UNDECODABLE_FRAMES)(
    "closes the client when it receives $name",
    async ({ frame, reason }) => {
      const { client, socket, disconnects } = connect();
      const pending = client.invoke(101);

      expect(() => socket.receive(frame())).not.toThrow();

      expect(disconnects).toEqual([
        { code: CLOSE_PROTOCOL_ERROR_CODE, reason: expect.stringMatching(reason) },
      ]);
      await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
      expect(socket.closeCalls).toBe(1);
      await expect(client.invoke(102)).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    }
  );

  it("reports the disconnect once and ignores everything that arrives afterwards", () => {
    const { client, socket, disconnects } = connect();

    socket.receive(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
    expect(() => {
      socket.receive(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));
      socket.receive(diffFrame(0, 1, [posSnapshot(1000, 1, 1)]));
      client.apply(0);
    }).not.toThrow();

    expect(disconnects).toHaveLength(1);
    expect(client.getEntity(1000)).toBeUndefined();
    expect(socket.closeCalls).toBe(1);
  });

  it("leaves the world intact so the application can reconnect", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(diffFrame(0, 1, [posSnapshot(1000, 4, 8)]));
    client.apply(0);

    socket.receive(Uint8Array.of(0xde, 0xad, 0xbe, 0xef));

    expect(disconnects).toHaveLength(1);
    expect(client.entity(1000).get(Position)).toMatchObject({ x: 4, y: 8 });
    // A fresh socket resynchronizes from its next baseline, as after any close().
    const replacement = new MemorySocket("server-2");
    client.attachSocket(replacement);
    replacement.receive(diffFrame(0, 1, [posSnapshot(1000, 5, 9)]));
    client.apply(10);
    expect(client.entity(1000).get(Position)).toMatchObject({ x: 5, y: 9 });
    expect(disconnects).toHaveLength(1);
    client.close();
  });
});

describe("ClientWorld snapshots it cannot decode", () => {
  it("closes the client and applies nothing more from the diff", async () => {
    const { client, socket, disconnects } = connect();
    socket.receive(diffFrame(0, 1, [posSnapshot(1003, 5, 5)]));
    client.apply(0);
    expect(client.entity(1003).get(Position)).toMatchObject({ x: 5, y: 5 });
    const pending = client.invoke(101);

    // One valid frame: a snapshot of a type this client never registered sits
    // between valid snapshots, and a removal follows them.
    socket.receive(
      diffFrame(
        1,
        2,
        [posSnapshot(1000, 1, 1), unregisteredSnapshot(1001), posSnapshot(1002, 2, 2)],
        [[1003, 1]]
      )
    );

    expect(() => client.apply(10)).not.toThrow();

    expect(disconnects).toEqual([
      {
        code: CLOSE_PROTOCOL_ERROR_CODE,
        reason: `protocol error: Received snapshot for unregistered component wire type ${UNREGISTERED_WIRE_TYPE}`,
      },
    ]);
    await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    expect(socket.closeCalls).toBe(1);
    // Nothing after the bad snapshot was applied: not the next snapshot, not the removal.
    expect(client.getEntity(1002)).toBeUndefined();
    expect(client.entity(1003).get(Position)).toMatchObject({ x: 5, y: 5 });
  });

  it("closes the client when a registered component's payload is malformed", () => {
    const { client, socket, disconnects } = connect();
    // Position has two i32 fields; an empty payload runs out of bytes.
    socket.receive(diffFrame(0, 1, [makeSnapshot(1000, 1, new Uint8Array())]));

    expect(() => client.apply(0)).not.toThrow();

    expect(disconnects).toEqual([
      { code: CLOSE_PROTOCOL_ERROR_CODE, reason: expect.stringMatching(PROTOCOL_ERROR) },
    ]);
    expect(socket.closeCalls).toBe(1);
  });

  it("closes the client from progress() without throwing out of the tick", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(diffFrame(0, 1, [unregisteredSnapshot(1000)]));

    expect(() => client.progress(0, 0)).not.toThrow();

    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]?.code).toBe(CLOSE_PROTOCOL_ERROR_CODE);
  });

  it.each(["progress", "apply"] as const)(
    "lets the disconnect handler dispose after %s finishes applying",
    (method) => {
      const { client, socket } = connect();
      const released: number[] = [];
      const events: string[] = [];
      client.component(Spark).on("remove", (entity) => released.push(entity.eid));
      const spark = client.entity().add(Spark);
      client.events.on("disconnect", () => {
        events.push("disconnect");
        expect(client.deferred).toBe(false);
        expect(client.entity(1000).get(Position)).toMatchObject({ x: 1, y: 1 });
        client.dispose();
        client.dispose();
      });
      client.system("After apply").run(() => {
        events.push("later system");
        expect(socket.closeCalls).toBe(1);
        expect(spark.alive).toBe(true);
        // A nested apply must not publish the disconnect before the outer progress finishes.
        client.apply(0);
        expect(events).toEqual(["later system"]);
      });
      socket.receive(diffFrame(0, 1, [posSnapshot(1000, 1, 1), unregisteredSnapshot(1001)]));

      expect(() => (method === "progress" ? client.progress(0, 0) : client.apply(0))).not.toThrow();

      expect(events).toEqual(
        method === "progress" ? ["later system", "disconnect"] : ["disconnect"]
      );
      expect(released).toEqual([spark.eid]);
      expect(spark.destroyed).toBe(true);
      expect(client.getEntity(1000)).toBeUndefined();
      expect(client.entities.values()).toEqual([]);
    }
  );

  it("does not close the client when application code throws while a valid snapshot is applied", () => {
    const { client, socket, disconnects } = connect();
    client.component(Position).on("set", () => {
      throw new Error("hook failed");
    });
    socket.receive(diffFrame(0, 1, [posSnapshot(1000, 1, 1)]));

    // An application bug is not a protocol error: it still reaches the caller.
    expect(() => client.apply(0)).toThrow("hook failed");

    expect(disconnects).toEqual([]);
    expect(socket.closeCalls).toBe(0);
    client.close();
  });

  it("still applies buffered frames in full after an ordinary disconnect", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(diffFrame(0, 1, [posSnapshot(1000, 1, 1), posSnapshot(1001, 2, 2)]));
    socket.close();

    // Being disconnected is not what stops apply(): only an undecodable snapshot does.
    client.apply(0);

    expect(disconnects).toEqual([undefined]);
    expect(client.entity(1000).get(Position)).toMatchObject({ x: 1, y: 1 });
    expect(client.entity(1001).get(Position)).toMatchObject({ x: 2, y: 2 });
  });
});

describe("ClientWorld diffs it cannot accept", () => {
  it("closes the client when a snapshot's envelope inside a decodable frame is malformed", async () => {
    const { client, socket, disconnects } = connect();
    socket.receive(diffFrame(0, 1, [posSnapshot(1000, 1, 1)]));
    client.apply(0);
    const pending = client.invoke(101);

    expect(() => socket.receive(diffFrame(1, 2, [malformedEnvelope(1001)]))).not.toThrow();

    expect(disconnects).toEqual([
      { code: CLOSE_PROTOCOL_ERROR_CODE, reason: expect.stringMatching(PROTOCOL_ERROR) },
    ]);
    await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    expect(socket.closeCalls).toBe(1);
    expect(client.entity(1000).get(Position)).toMatchObject({ x: 1, y: 1 });
  });

  it("closes the client when a diff starts after the last frame it acknowledged", async () => {
    const { client, socket, disconnects } = connect();
    // Frame 1 stays buffered, so the buffer checks the next diff against it.
    socket.receive(diffFrame(0, 1, [posSnapshot(1000, 1, 1)]));
    const pending = client.invoke(101);

    // fromFrame 5 skips frames the client never acked, which a server that honors acks never does.
    expect(() => socket.receive(diffFrame(5, 6, [posSnapshot(1000, 2, 2)]))).not.toThrow();

    // The application sees this reason, so it names both frames.
    expect(disconnects).toEqual([
      {
        code: CLOSE_PROTOCOL_ERROR_CODE,
        reason: "protocol error: diff starts at frame 5, past this client's frame 1",
      },
    ]);
    await expect(pending).rejects.toMatchObject({ code: RPC_CLOSED_CODE });
    expect(socket.closeCalls).toBe(1);
  });

  it("keeps the replicated entities when a baseline is malformed", () => {
    const { client, socket, disconnects } = connect();
    const resets: Array<{ initial: boolean; toFrame: number }> = [];
    client.events.on("reset", (event) =>
      resets.push({ initial: event.initial, toFrame: event.toFrame })
    );
    socket.receive(diffFrame(0, 1, [posSnapshot(1000, 4, 8)]));
    client.apply(0);

    // A newer baseline that cannot be read must be rejected before the world is torn down.
    expect(() => socket.receive(diffFrame(0, 2, [malformedEnvelope(1001)]))).not.toThrow();

    expect(disconnects).toEqual([
      { code: CLOSE_PROTOCOL_ERROR_CODE, reason: expect.stringMatching(PROTOCOL_ERROR) },
    ]);
    expect(client.entity(1000).get(Position)).toMatchObject({ x: 4, y: 8 });
    expect(resets).toEqual([{ initial: true, toFrame: 1 }]);
  });

  it("skips a stale baseline without decoding it", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(diffFrame(0, 5, [posSnapshot(1000, 1, 1)]));

    // A straggler baseline behind frame 5: its malformed snapshot is never read.
    expect(() => socket.receive(diffFrame(0, 3, [malformedEnvelope(1001)]))).not.toThrow();

    expect(disconnects).toEqual([]);
    expect(socket.closeCalls).toBe(0);
    client.close();
  });

  it("still throws what an application reset handler throws, without closing the client", () => {
    const { client, socket, disconnects } = connect();
    client.events.on("reset", () => {
      throw new Error("reset handler failed");
    });

    expect(() => socket.receive(diffFrame(0, 1, [posSnapshot(1000, 1, 1)]))).toThrow(
      "reset handler failed"
    );

    expect(disconnects).toEqual([]);
    expect(socket.closeCalls).toBe(0);
    client.close();
  });
});
