import { describe, expect, it } from "vitest";
import { Decoder, Encoder, type IEncodable, wireType } from "@vworlds/vecs-wire";
import { Relationship } from "@vworlds/vecs";
import {
  CLOSE_PROTOCOL_ERROR_CODE,
  Client2Server,
  ComponentSnapshot,
  EncodedSnapshot,
  RPC,
  Server2Client,
  StateDiff,
  cid_pack,
  decodeRelationshipSnapshot,
  encodeRelationshipSnapshot,
} from "../src/index.js";

class WeightedLink extends Relationship {
  @wireType("i32")
  public weight = 0;
}

class EmptyLink extends Relationship {}

function encodeMessage(message: IEncodable, size = 64 * 1024): Uint8Array {
  const encoder = new Encoder(new Uint8Array(size));
  encoder.write(message);
  return encoder.getBuffer();
}

describe("protocol messages", () => {
  it("round-trips server diffs with snapshots, removals, and RPC", () => {
    const payload = Uint8Array.from([1, 2, 3]);
    const snapshotCid = cid_pack(12, 3);
    const snapshotBytes = encodeMessage(new ComponentSnapshot({ eid: 12, wireType: 3, payload }));
    const legacySnapshotBytes = new Encoder(new Uint8Array(64));
    legacySnapshotBytes.write_u32(snapshotCid);
    legacySnapshotBytes.write_buffer(payload);
    const message = new Server2Client({
      diff: new StateDiff({
        fromFrame: 5,
        toFrame: 6,
        snapshots: [new EncodedSnapshot(snapshotBytes, 12, 3)],
        removed: [[12, 4]],
      }),
      rpc: [new RPC({ rpcId: 0, callId: 9, params: ["ok"] })],
    });

    const decoded = new Decoder(encodeMessage(message)).read(Server2Client);

    expect(decoded.diff?.fromFrame).toBe(5);
    expect(decoded.diff?.toFrame).toBe(6);
    expect(decoded.diff?.removed).toEqual([[12, 4]]);
    expect(decoded.diff!.snapshots[0].eid).toBe(0);
    expect(decoded.diff!.snapshots[0].wireType).toBe(0);
    expect(snapshotBytes).toEqual(legacySnapshotBytes.getBuffer());
    expect(new Decoder(decoded.diff!.snapshots[0].bytes).read(ComponentSnapshot)).toEqual(
      new ComponentSnapshot({ eid: 12, wireType: 3, payload })
    );
    expect(decoded.rpc[0].params).toEqual(["ok"]);
  });

  it("round-trips a close notice with and without a code and reason", () => {
    const decode = (close: Server2Client["close"]) =>
      new Decoder(encodeMessage(new Server2Client({ close }))).read(Server2Client);

    expect(decode({ code: 4003, reason: "superseded" }).close).toEqual({
      code: 4003,
      reason: "superseded",
    });
    expect(decode({ code: 0 }).close).toEqual({ code: 0 });
    expect(decode({ reason: "" }).close).toEqual({ reason: "" });
    expect(decode({}).close).toEqual({});
    expect(decode(undefined).close).toBeUndefined();
  });

  it("carries a close notice alongside the diff and RPC replies", () => {
    const message = new Server2Client({
      diff: new StateDiff({ fromFrame: 3, toFrame: 4 }),
      rpc: [new RPC({ rpcId: 0, callId: 1, params: ["ok"] })],
      close: { code: 4003, reason: "superseded" },
    });

    const decoded = new Decoder(encodeMessage(message)).read(Server2Client);

    expect(decoded.diff?.toFrame).toBe(4);
    expect(decoded.rpc[0].params).toEqual(["ok"]);
    expect(decoded.close).toEqual({ code: 4003, reason: "superseded" });
  });

  it("carries the reserved protocol-error code in a close notice", () => {
    const close = { code: CLOSE_PROTOCOL_ERROR_CODE, reason: "protocol error: bad frame" };

    const decoded = new Decoder(encodeMessage(new Server2Client({ close }))).read(Server2Client);

    expect(CLOSE_PROTOCOL_ERROR_CODE).toBe(1);
    expect(decoded.close).toEqual({ code: 1, reason: "protocol error: bad frame" });
  });

  it("rejects a frame it cannot decode instead of returning a partial message", () => {
    const decodeServer = (bytes: Uint8Array) => () => new Decoder(bytes).read(Server2Client);
    const decodeClient = (bytes: Uint8Array) => () => new Decoder(bytes).read(Client2Server);
    const whole = encodeMessage(
      new Client2Server({
        ackFrame: 3,
        rpc: [new RPC({ rpcId: 101, callId: 1, params: ["hello"] })],
      })
    );

    // A field tag no protocol version defines, after a well-formed prefix.
    expect(decodeServer(Uint8Array.of(99))).toThrow("Invalid Server2Client field tag 99");
    expect(decodeClient(Uint8Array.of(0, 99))).toThrow("Invalid Client2Server field tag 99");
    // Bytes that run out inside a field, or before the ack a client frame must start with.
    expect(decodeClient(whole.slice(0, whole.length - 3))).toThrow(RangeError);
    expect(decodeClient(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))).toThrow(RangeError);
  });

  it("encodes a frame without a notice exactly as before", () => {
    const message = new Server2Client({ diff: new StateDiff({ fromFrame: 3, toFrame: 4 }) });

    expect(encodeMessage(message)).toEqual(
      encodeMessage(new Server2Client({ diff: message.diff, close: undefined }))
    );
    expect(new Decoder(encodeMessage(message)).read(Server2Client).close).toBeUndefined();
  });

  it("round-trips client acks with arbitrary input", () => {
    const message = new Client2Server({
      ackFrame: 7,
      input: { keys: ["up"], aim: 90 },
      rpc: [new RPC({ rpcId: 101, callId: 1, params: [1, true] })],
    });

    const decoded = new Decoder(encodeMessage(message)).read(Client2Server);

    expect(decoded.ackFrame).toBe(7);
    expect(decoded.input).toEqual({ keys: ["up"], aim: 90 });
    expect(decoded.rpc[0].rpcId).toBe(101);
  });

  it("round-trips all relationship targets and ordinary fields", () => {
    const relationship = new WeightedLink();
    relationship.weight = 17;
    const encoder = new Encoder(new Uint8Array(128));
    encodeRelationshipSnapshot(encoder, [1001, 1004, 1010], relationship);

    const decoded = decodeRelationshipSnapshot(new Decoder(encoder.getBuffer()), WeightedLink);

    expect(decoded.targetEids).toEqual([1001, 1004, 1010]);
    expect(decoded.component).toMatchObject({ weight: 17 });
  });

  it("round-trips a fieldless relationship subclass", () => {
    const encoder = new Encoder(new Uint8Array(128));
    encodeRelationshipSnapshot(encoder, [1001], new EmptyLink());

    const decoded = decodeRelationshipSnapshot(new Decoder(encoder.getBuffer()), EmptyLink);

    expect(decoded.targetEids).toEqual([1001]);
    expect(decoded.component).toBeInstanceOf(EmptyLink);
  });

  it("rejects malformed relationship targets", () => {
    const duplicateEncoder = new Encoder(new Uint8Array(128));
    duplicateEncoder.write_u32(2);
    duplicateEncoder.write_u32(1001);
    duplicateEncoder.write_u32(1001);
    duplicateEncoder.write(new WeightedLink());

    expect(() =>
      decodeRelationshipSnapshot(new Decoder(duplicateEncoder.getBuffer()), WeightedLink)
    ).toThrow("duplicate target eid 1001");

    const emptyEncoder = new Encoder(new Uint8Array(128));
    emptyEncoder.write_u32(0);
    emptyEncoder.write(new WeightedLink());
    expect(() =>
      decodeRelationshipSnapshot(new Decoder(emptyEncoder.getBuffer()), WeightedLink)
    ).toThrow("at least one target");
  });
});

describe("rpcSettledBelow", () => {
  it("round-trips on a client ack next to the input and requests", () => {
    const message = new Client2Server({
      ackFrame: 7,
      input: { keys: ["up"] },
      rpc: [new RPC({ rpcId: 101, callId: 12, params: [1] })],
      rpcSettledBelow: 12,
    });

    const decoded = new Decoder(encodeMessage(message)).read(Client2Server);

    expect(decoded.rpcSettledBelow).toBe(12);
    expect(decoded.ackFrame).toBe(7);
    expect(decoded.input).toEqual({ keys: ["up"] });
    expect(decoded.rpc[0].callId).toBe(12);
  });

  it("round-trips on a server frame next to the diff, replies and close notice", () => {
    const message = new Server2Client({
      diff: new StateDiff({ fromFrame: 3, toFrame: 4 }),
      rpc: [new RPC({ rpcId: 0, callId: 1, params: ["ok"] })],
      close: { code: 4003, reason: "superseded" },
      rpcSettledBelow: 9,
    });

    const decoded = new Decoder(encodeMessage(message)).read(Server2Client);

    expect(decoded.rpcSettledBelow).toBe(9);
    expect(decoded.diff?.toFrame).toBe(4);
    expect(decoded.rpc[0].params).toEqual(["ok"]);
    expect(decoded.close).toEqual({ code: 4003, reason: "superseded" });
  });

  it("round-trips the largest value a u32 carries", () => {
    const max = 0xffff_ffff;

    expect(
      new Decoder(encodeMessage(new Client2Server({ rpcSettledBelow: max }))).read(Client2Server)
        .rpcSettledBelow
    ).toBe(max);
    expect(
      new Decoder(encodeMessage(new Server2Client({ rpcSettledBelow: max }))).read(Server2Client)
        .rpcSettledBelow
    ).toBe(max);
  });

  it("encodes as tag 5 followed by a varint u32", () => {
    expect(encodeMessage(new Client2Server({ ackFrame: 7, rpcSettledBelow: 300 }))).toEqual(
      Uint8Array.of(7, 5, 0xac, 0x02)
    );
    expect(encodeMessage(new Server2Client({ rpcSettledBelow: 1 }))).toEqual(Uint8Array.of(5, 1));
  });

  it("is absent at 0, so the frame of a peer that never issued a call is byte-identical to before", () => {
    // Hand-built from the field layout that predates the watermark.
    const ask = [new RPC({ rpcId: 101, callId: 0 })];
    const legacyAck = Uint8Array.of(7, 2, 1, 101, 0, 0, 0, 0);
    expect(encodeMessage(new Client2Server({ ackFrame: 7, rpc: ask }))).toEqual(legacyAck);
    expect(encodeMessage(new Client2Server({ ackFrame: 7, rpc: ask, rpcSettledBelow: 0 }))).toEqual(
      legacyAck
    );

    const answer = [new RPC({ rpcId: 0, callId: 1 })];
    const diff = new StateDiff({ fromFrame: 3, toFrame: 4 });
    const legacyFrame = Uint8Array.of(1, 4, 3, 0, 0, 2, 1, 0, 1, 0, 0, 0);
    expect(encodeMessage(new Server2Client({ diff, rpc: answer }))).toEqual(legacyFrame);
    expect(encodeMessage(new Server2Client({ diff, rpc: answer, rpcSettledBelow: 0 }))).toEqual(
      legacyFrame
    );
    expect(encodeMessage(new Server2Client({ rpcSettledBelow: 0 }))).toEqual(new Uint8Array());
  });

  it("rejects a truncated watermark field", () => {
    expect(() => new Decoder(Uint8Array.of(7, 5)).read(Client2Server)).toThrow(RangeError);
    expect(() => new Decoder(Uint8Array.of(5)).read(Server2Client)).toThrow(RangeError);
  });

  it("still rejects an unknown field tag in either direction", () => {
    expect(() => new Decoder(Uint8Array.of(7, 6)).read(Client2Server)).toThrow(
      "Invalid Client2Server field tag 6"
    );
    expect(() => new Decoder(Uint8Array.of(6)).read(Server2Client)).toThrow(
      "Invalid Server2Client field tag 6"
    );
  });
});
