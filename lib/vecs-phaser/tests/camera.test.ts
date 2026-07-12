import { describe, expect, it } from "vitest";
import { Relationship } from "@vworlds/vecs";
import { Decoder, Encoder, wireType } from "@vworlds/vecs-wire";
import { CameraBounds, CameraFollow, CameraShake, CameraZoom } from "../src/components/camera.js";

// vecs-protocol registers Relationship.target as an "entity" wire field at
// module load; this package doesn't depend on it, so mirror the registration
// (idempotent — duplicate registration with the same spec is a no-op).
wireType("entity")(Relationship.prototype, "target");

function roundTrip<T extends object>(C: new () => T, value: T): T {
  const enc = new Encoder(new Uint8Array(1024));
  enc.write(value);
  return new Decoder(enc.getBuffer()).read(C);
}

describe("CameraFollow", () => {
  it("round-trips the inherited target (as eid) plus the lerp payload", () => {
    const follow = new CameraFollow();
    (follow as unknown as { target: { eid: number } }).target = { eid: 1234 };
    follow.lerp = 0.25;

    const decoded = roundTrip(CameraFollow, follow);
    expect(decoded).toBeInstanceOf(CameraFollow);
    expect(decoded.target as unknown as number).toBe(1234);
    expect(decoded.lerp).toBe(0.25);
  });
});

describe("CameraZoom", () => {
  it("round-trips zoom values", () => {
    const zoom = new CameraZoom();
    zoom.value = 2.5;
    expect(roundTrip(CameraZoom, zoom).value).toBe(2.5);
  });
});

describe("CameraBounds", () => {
  it("round-trips a bottom-left-anchored rect in meters", () => {
    const bounds = new CameraBounds();
    bounds.x = -4.5;
    bounds.y = -3;
    bounds.width = 9;
    bounds.height = 6;
    const decoded = roundTrip(CameraBounds, bounds);
    expect(decoded).toMatchObject({ x: -4.5, y: -3, width: 9, height: 6 });
  });
});

describe("CameraShake", () => {
  it("round-trips duration and intensity", () => {
    const shake = new CameraShake();
    shake.duration = 0.5;
    shake.intensity = 0.05;
    const decoded = roundTrip(CameraShake, shake);
    expect(decoded.duration).toBe(0.5);
    expect(decoded.intensity).toBeCloseTo(0.05);
  });
});
