import { describe, expect, it } from "vitest";
import {
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Decoder, Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import type { EID } from "@vworlds/vecs";
import {
  CLOSE_PROTOCOL_ERROR_CODE,
  ClientWorld,
  type ClientWorldDisconnectEvent,
} from "../src/index.js";

// A server with `redundancyFrames` sends each frame as a delta from a base it presumes the client
// holds, and marks the frame optimistic when that base is past the client's last ack. When the frames
// before it were lost the client holds the diff until they arrive, reports the gap on its next ack,
// and the server falls back to deltas from the ack. A diff that starts past the client's frame
// without the marker is still the server's mistake, and still a protocol error.

// Two network components, as in protocol_error.test.ts: the packed component id depends on how many
// there are, so every file with its own count has its own test file.
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

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly sent: Uint8Array[] = [];
  public closeCalls = 0;
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public constructor(public readonly id: string) {}

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    const handlers = this._handlers.get(event) ?? [];
    handlers.push(handler);
    this._handlers.set(event, handlers);
    return this;
  }

  public send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }

  public close(): void {
    this.closeCalls += 1;
    this._handlers.get("disconnect")?.forEach((handler) => handler());
  }
}

function encodeMessage(message: IEncodable): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(message);
  return encoder.getBuffer();
}

function posSnapshot(eid: EID, x: number): EncodedSnapshot {
  const position = new Position();
  position.x = x;
  const payload = new Encoder(new Uint8Array(64));
  payload.write(position);
  return new EncodedSnapshot(
    encodeMessage(new ComponentSnapshot({ eid, wireType: 1, payload: payload.getBuffer() })),
    eid,
    1
  );
}

/** A frame from the server: the diff from `fromFrame` to `toFrame`, optimistic when `optimistic`. */
function frame(
  fromFrame: number,
  toFrame: number,
  snapshots: EncodedSnapshot[] = [],
  optimistic = false
): Uint8Array {
  return encodeMessage(
    new Server2Client({ diff: new StateDiff({ fromFrame, toFrame, snapshots }), optimistic })
  );
}

/**
 * The first frame of every connection. A function, not a constant: the packed component id depends
 * on the network components the first `ClientWorld` registers, so it can only be built after one.
 */
function baseline(): Uint8Array {
  return frame(0, 1, [posSnapshot(1000, 1)]);
}

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

/** What the client's most recent message told the server. */
function lastAck(socket: MemorySocket): Client2Server {
  return new Decoder(socket.sent[socket.sent.length - 1]).read(Client2Server);
}

/** Apply the frames the client has buffered, one render frame at a time. */
function applyAll(client: ClientWorld): void {
  for (let now = 0; now <= 100; now += 10) {
    client.apply(now);
  }
}

function xOf(client: ClientWorld, eid: EID): number | undefined {
  return client.entity(eid).get(Position)?.x;
}

describe("a client that receives an optimistic diff it cannot apply yet", () => {
  it("holds it instead of closing, and reports the gap on its next ack", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(baseline());

    // Frames 2 and 3 were lost; the server presumed the client held frame 3.
    expect(() => socket.receive(frame(3, 4, [posSnapshot(1000, 4)], true))).not.toThrow();
    client.send();

    expect(disconnects).toEqual([]);
    expect(socket.closeCalls).toBe(0);
    expect(lastAck(socket)).toMatchObject({ ackFrame: 1, gap: true });
    // Nothing was applied: the diff waits for the frames it was built on.
    applyAll(client);
    expect(xOf(client, 1000)).toBe(1);
    client.close();
  });

  it("reports the gap once, not on every ack", () => {
    const { client, socket } = connect();
    socket.receive(baseline());
    socket.receive(frame(3, 4, [posSnapshot(1000, 4)], true));

    client.send();
    client.send();
    client.send();

    expect(socket.sent.map((bytes) => new Decoder(bytes).read(Client2Server).gap)).toEqual([
      true,
      false,
      false,
    ]);
    client.close();
  });

  it("reports it again when another diff arrives that it cannot use", () => {
    const { client, socket } = connect();
    socket.receive(baseline());
    socket.receive(frame(3, 4, [], true));
    client.send();
    socket.receive(frame(4, 5, [], true));
    client.send();
    client.send();

    expect(socket.sent.map((bytes) => new Decoder(bytes).read(Client2Server).gap)).toEqual([
      true,
      true,
      false,
    ]);
    client.close();
  });

  it("applies the held diff when a late frame brings the client up to its base, with no round trip", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(baseline());
    socket.receive(frame(3, 4, [posSnapshot(1000, 4)], true));

    // Frame 3 was only delayed: it arrives after the frame built on it.
    socket.receive(frame(1, 3, [posSnapshot(1000, 3)]));
    applyAll(client);

    expect(disconnects).toEqual([]);
    expect(xOf(client, 1000)).toBe(4);
    // The held diff is applied, so the ack names its frame.
    client.send();
    expect(lastAck(socket).ackFrame).toBe(4);
    client.close();
  });

  it("does not report a gap that closed before the next ack", () => {
    const { client, socket } = connect();
    socket.receive(baseline());
    socket.receive(frame(3, 4, [], true));
    socket.receive(frame(1, 3));

    client.send();

    expect(lastAck(socket)).toMatchObject({ ackFrame: 4, gap: false });
    client.close();
  });

  it("drops the held diff when the server's fallback delta covers it", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(baseline());
    socket.receive(frame(3, 4, [posSnapshot(1000, 4)], true));
    client.send();
    expect(lastAck(socket)).toMatchObject({ ackFrame: 1, gap: true });

    // The fallback starts from the ack the server saw, and reaches past the held diff.
    socket.receive(frame(1, 6, [posSnapshot(1000, 6)]));
    applyAll(client);
    client.send();

    expect(disconnects).toEqual([]);
    expect(xOf(client, 1000)).toBe(6);
    expect(lastAck(socket)).toMatchObject({ ackFrame: 6, gap: false });
    client.close();
  });

  it("applies several held diffs in order once the first of them is within reach", () => {
    const { client, socket } = connect();
    socket.receive(baseline());
    socket.receive(frame(5, 6, [posSnapshot(1000, 6)], true));
    socket.receive(frame(3, 4, [posSnapshot(1000, 4)], true));
    socket.receive(frame(4, 5, [posSnapshot(1000, 5)], true));

    socket.receive(frame(1, 3, [posSnapshot(1000, 3)]));
    applyAll(client);

    expect(xOf(client, 1000)).toBe(6);
    client.send();
    expect(lastAck(socket).ackFrame).toBe(6);
    client.close();
  });

  it("forgets the held diff on a baseline", () => {
    const { client, socket } = connect();
    socket.receive(baseline());
    socket.receive(frame(3, 4, [posSnapshot(1000, 4)], true));

    socket.receive(frame(0, 9, [posSnapshot(1000, 9)]));
    client.send();

    expect(lastAck(socket)).toMatchObject({ ackFrame: 9, gap: false });
    client.close();
  });

  it("sends no gap field at all while there is none, so its acks are as they were", () => {
    const { client, socket } = connect();
    socket.receive(baseline());
    socket.receive(frame(1, 2, [posSnapshot(1000, 2)]));

    client.send();

    // Just the ack frame: no gap tag.
    expect(socket.sent[socket.sent.length - 1]).toEqual(Uint8Array.of(2));
    client.close();
  });
});

describe("a client that receives a diff it cannot apply, without the marker", () => {
  it("still closes with a protocol error, because a server that honors acks never sends one", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(baseline());

    expect(() => socket.receive(frame(3, 4, [posSnapshot(1000, 4)]))).not.toThrow();

    expect(disconnects).toEqual([
      {
        code: CLOSE_PROTOCOL_ERROR_CODE,
        reason: "protocol error: diff starts at frame 3, past this client's frame 1",
      },
    ]);
    expect(socket.closeCalls).toBe(1);
  });

  it("still closes while it holds an optimistic diff", () => {
    const { client, socket, disconnects } = connect();
    socket.receive(baseline());
    socket.receive(frame(3, 4, [], true));
    expect(disconnects).toEqual([]);

    socket.receive(frame(3, 5));

    expect(disconnects).toEqual([
      {
        code: CLOSE_PROTOCOL_ERROR_CODE,
        reason: "protocol error: diff starts at frame 3, past this client's frame 1",
      },
    ]);
    expect(client).toBeDefined();
  });
});
