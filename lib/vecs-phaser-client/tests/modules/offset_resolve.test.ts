import type { Entity } from "@vworlds/vecs";
import { ClientWorld } from "@vworlds/vecs-client";
import {
  Arc,
  DrawBy,
  InheritRotation,
  Offset,
  OpenPath,
  phaserNetworkComponents,
  Polygon,
  Position,
  Rotation,
  Text,
} from "@vworlds/vecs-phaser";
import {
  ComponentSnapshot,
  EncodedSnapshot,
  Server2Client,
  StateDiff,
  type VecsSocket,
} from "@vworlds/vecs-protocol";
import { Encoder } from "@vworlds/vecs-wire";
import { describe, expect, it } from "vitest";

import { PhaserRenderModule, phaserInterpolators } from "../../src/index.js";
import { createMockScene } from "../mock_phaser.js";
import {
  ellipse,
  expectPose,
  expectRendered,
  gameObjectOf,
  HALF_PI,
  lastCall,
  methods,
  PPM,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  setup,
  spawnChild,
  spawnParent,
  tagChild,
} from "./parenting_fixtures.js";
import { CidLayout } from "@vworlds/vecs-protocol";

const testCid = new CidLayout(2 ** Math.ceil(Math.log2(phaserNetworkComponents.length + 1)));

describe("phaser.resolve.offset: untagged DrawBy children", () => {
  it("add the offset as is under a rotated parent", () => {
    const { world } = setup();
    const parent = spawnParent(world, 1, 2, HALF_PI);
    const child = spawnChild(world, parent, { offset: { x: 2, y: 1 } });

    world.progress(0, 0);

    expectPose(child, { x: 3, y: 3 });

    parent.set(Rotation, { angle: Math.PI });
    world.progress(1, 16);

    expectPose(child, { x: 3, y: 3 });
  });

  it("keep their own Rotation, whatever the parent's", () => {
    const { world } = setup();
    const parent = spawnParent(world, 0, 0, HALF_PI);
    const child = spawnChild(world, parent, { offset: { x: 1, y: 0 } });
    child.set(Rotation, { angle: 0.3 });

    world.progress(0, 0);
    parent.set(Rotation, { angle: 2 });
    world.progress(1, 16);

    expect(child.get(Rotation)?.angle).toBe(0.3);
    expect(lastCall(gameObjectOf(child), "setRotation")).toEqual([-0.3]);
  });

  it("do not get a Rotation they never had", () => {
    const { world } = setup();
    const parent = spawnParent(world, 0, 0, HALF_PI);
    const child = spawnChild(world, parent, { offset: { x: 1, y: 0 } });

    world.progress(0, 0);

    expect(child.has(Rotation)).toBe(false);
  });
});

const polygonPoints = [0, 0, 0.5, 0, 0.5, 0.5];

describe.each([
  {
    name: "Polygon",
    kind: "polygon",
    shape: (entity: Entity) => entity.set(Polygon, { points: polygonPoints }),
  },
  {
    name: "Polygon with OpenPath",
    kind: "polygon",
    shape: (entity: Entity) => entity.set(Polygon, { points: polygonPoints }).add(OpenPath),
  },
  {
    name: "Text",
    kind: "text",
    shape: (entity: Entity) => entity.set(Text, { value: "crack", fontSize: 16, color: 0xffffff }),
  },
  {
    name: "Arc",
    kind: "arc",
    shape: (entity: Entity) => entity.set(Arc, { radius: 0.1 }),
  },
])("phaser.resolve.offset: a $name InheritRotation child", ({ kind, shape }) => {
  it("sits at the rotated offset and renders the parent's angle plus its own", () => {
    const { world } = setup();
    const parent = spawnParent(world, 1, 2, HALF_PI);
    const child = spawnChild(world, parent, { offset: { x: 2, y: 1 }, tag: 0.25, shape });

    world.progress(0, 0);

    // A quarter turn counter-clockwise takes the offset (2, 1) to (-1, 2).
    expectPose(child, { x: 0, y: 4, angle: HALF_PI + 0.25 });
    const obj = gameObjectOf(child);
    expect(obj.kind).toBe(kind);
    expectRendered(obj, { x: 0, y: 4, angle: HALF_PI + 0.25 });
  });

  it("keeps up with the parent across frames", () => {
    const { world } = setup();
    const parent = spawnParent(world, 1, 2, HALF_PI);
    const child = spawnChild(world, parent, { offset: { x: 2, y: 1 }, tag: 0.25, shape });
    world.progress(0, 0);

    parent.set(Position, { x: -1, y: 0 }).set(Rotation, { angle: Math.PI });
    world.progress(1, 16);

    // The offset (2, 1) turned by 180 degrees is (-2, -1).
    expectPose(child, { x: -3, y: -1, angle: Math.PI + 0.25 });
    expectRendered(gameObjectOf(child), { x: -3, y: -1, angle: Math.PI + 0.25 });
  });
});

describe("phaser.resolve.offset: InheritRotation children", () => {
  it("turn the offset by the parent's angle whatever it is, not only by quarter turns", () => {
    const { world } = setup();
    const parent = spawnParent(world, 1, 1, Math.PI / 6);
    const along = spawnChild(world, parent, { offset: { x: 2, y: 0 }, tag: 0 });
    const across = spawnChild(world, parent, { offset: { x: 0, y: 2 }, tag: 0 });

    world.progress(0, 0);

    // Thirty degrees: cos is sqrt(3) / 2 and sin is 1 / 2.
    expectPose(along, { x: 1 + Math.sqrt(3), y: 1 + 1 });
    expectPose(across, { x: 1 - 1, y: 1 + Math.sqrt(3) });
  });

  it("keep position and rotation in lockstep with the parent on every frame", () => {
    const { world } = setup();
    const parent = spawnParent(world, 0, 0, 0);
    const child = spawnChild(world, parent, { offset: { x: 1, y: 2 }, tag: 0.5 });
    world.progress(0, 0);
    expectRendered(gameObjectOf(child), { x: 1, y: 2, angle: 0.5 });

    // The offset (1, 2) turned by 90, 180 and -90 degrees is (-2, 1), (-1, -2) and (2, -1).
    const frames = [
      { parent: { x: 1, y: 0, angle: HALF_PI }, child: { x: -1, y: 1 } },
      { parent: { x: 1, y: 1, angle: Math.PI }, child: { x: 0, y: -1 } },
      { parent: { x: -2, y: 1, angle: -HALF_PI }, child: { x: 0, y: 0 } },
    ];
    frames.forEach((frame, index) => {
      parent.set(Position, { x: frame.parent.x, y: frame.parent.y });
      parent.set(Rotation, { angle: frame.parent.angle });
      const obj = gameObjectOf(child);
      obj.calls.length = 0;

      world.progress(index + 1, 16);

      const expected = { ...frame.child, angle: frame.parent.angle + 0.5 };
      expectPose(child, expected);
      expectRendered(obj, expected);
      // Both were pushed to the GameObject by this very frame.
      expect(methods(obj, "setPosition").length).toBeGreaterThan(0);
      expect(methods(obj, "setRotation").length).toBeGreaterThan(0);
    });
  });

  it("treat a parent without Rotation as angle 0", () => {
    const { world } = setup();
    const parent = spawnParent(world, 1, 1);
    const child = spawnChild(world, parent, { offset: { x: 1, y: 2 }, tag: 0.5 });

    world.progress(0, 0);

    expectPose(child, { x: 2, y: 3, angle: 0.5 });
  });

  it("sit at the parent when there is no Offset, and still follow its rotation", () => {
    const { world } = setup();
    const parent = spawnParent(world, 3, 4, HALF_PI);
    const child = spawnChild(world, parent, { tag: -0.5 });

    world.progress(0, 0);

    expectPose(child, { x: 3, y: 4, angle: HALF_PI - 0.5 });
  });

  it("follow a parent they are retargeted to in the same frame", () => {
    const { world } = setup();
    const first = spawnParent(world, 0, 0, 0);
    const second = spawnParent(world, 10, 10, Math.PI);
    const child = spawnChild(world, first, { offset: { x: 1, y: 2 }, tag: 0 });

    world.progress(0, 0);
    expectPose(child, { x: 1, y: 2, angle: 0 });

    child.add(DrawBy, second);
    world.progress(1, 16);

    expectPose(child, { x: 9, y: 8, angle: Math.PI });
  });

  it("do nothing without DrawBy", () => {
    const { world } = setup();
    const entity = ellipse(world.entity());
    entity.set(Rotation, { angle: 1 }).set(InheritRotation, { angle: 0.7 });

    world.progress(0, 0);
    world.progress(1, 16);

    expect(entity.get(Rotation)?.angle).toBe(1);
    expect(entity.has(Position)).toBe(false);
  });
});

describe("phaser.resolve.offset: nested chains", () => {
  it("compose tagged children of tagged children within one frame, whatever their entity ids", () => {
    const { world } = setup();
    // The deepest entity is created first, so it has the lowest id: a pass ordered by id would
    // resolve it before its parents and lag a frame behind.
    const grandchild = world.entity();
    const child = world.entity();
    const root = world.entity();
    root.set(Position, { x: 1, y: 1 }).set(Rotation, { angle: HALF_PI }).set(Arc, { radius: 0.5 });
    tagChild(child, root, { x: 2, y: 1 }, HALF_PI);
    tagChild(grandchild, child, { x: 1, y: 2 }, 0);

    world.progress(0, 0);

    // child: the offset (2, 1) turned by 90 degrees is (-1, 2); angle 90 + 90 degrees.
    expectPose(child, { x: 0, y: 3, angle: Math.PI });
    // grandchild: the offset (1, 2) turned by 180 degrees is (-1, -2); angle 180 + 0 degrees.
    expectPose(grandchild, { x: -1, y: 1, angle: Math.PI });

    root.set(Position, { x: 0, y: 0 }).set(Rotation, { angle: 0 });
    world.progress(1, 16);

    expectPose(child, { x: 2, y: 1, angle: HALF_PI });
    // grandchild: (1, 2) turned by 90 degrees is (-2, 1).
    expectPose(grandchild, { x: 0, y: 2, angle: HALF_PI });
    expectRendered(gameObjectOf(grandchild), { x: 0, y: 2, angle: HALF_PI });
  });

  it("resolve a tagged, untagged, tagged chain within one frame, whatever the entity ids", () => {
    const { world } = setup();
    const last = world.entity();
    const untagged = world.entity();
    const first = world.entity();
    const root = world.entity();
    root.set(Position, { x: 1, y: 1 }).set(Rotation, { angle: HALF_PI }).set(Arc, { radius: 0.5 });
    tagChild(first, root, { x: 2, y: 1 }, 0.25);
    // The untagged link keeps its own rotation, and its offset stays in world axes.
    ellipse(untagged).add(DrawBy, first).set(Offset, { x: 1, y: 2 });
    untagged.set(Rotation, { angle: Math.PI });
    tagChild(last, untagged, { x: 1, y: 2 }, 0.5);

    world.progress(0, 0);

    // first: the offset (2, 1) turned by 90 degrees is (-1, 2).
    expectPose(first, { x: 0, y: 3, angle: HALF_PI + 0.25 });
    expectPose(untagged, { x: 1, y: 5, angle: Math.PI });
    // last: the offset (1, 2) turned by the untagged link's own 180 degrees is (-1, -2).
    expectPose(last, { x: 0, y: 3, angle: Math.PI + 0.5 });

    root.set(Position, { x: 0, y: 0 }).set(Rotation, { angle: 0 });
    world.progress(1, 16);

    expectPose(first, { x: 2, y: 1, angle: 0.25 });
    expectPose(untagged, { x: 3, y: 3, angle: Math.PI });
    expectPose(last, { x: 2, y: 1, angle: Math.PI + 0.5 });
    expectRendered(gameObjectOf(last), { x: 2, y: 1, angle: Math.PI + 0.5 });
  });

  it("let an untagged child hang below a tagged one without turning its offset", () => {
    const { world } = setup();
    const root = spawnParent(world, 0, 0, HALF_PI);
    const tagged = spawnChild(world, root, { offset: { x: 1, y: 2 }, tag: 0 });
    const untagged = spawnChild(world, tagged, { offset: { x: 1, y: 2 } });

    world.progress(0, 0);

    expectPose(tagged, { x: -2, y: 1, angle: HALF_PI });
    expectPose(untagged, { x: -1, y: 3 });
    expect(untagged.has(Rotation)).toBe(false);
  });
});

describe("phaser.resolve.offset: interpolated parents", () => {
  it("follow the parent's interpolated Position and Rotation in the same frame", () => {
    const world = new ClientWorld({
      networkComponents: phaserNetworkComponents,
      interpolators: phaserInterpolators(),
      serverTickIntervalMs: 10,
    });
    world.module(PhaserRenderModule, {
      scene: createMockScene(SCENE_WIDTH, SCENE_HEIGHT),
      pixelsPerMeter: PPM,
    });
    const socket = new MemorySocket();
    world.attachSocket(socket);
    socket.receive(frame(0, 1, parentPose(0, 0, 0)));
    socket.receive(frame(1, 2, parentPose(4, 0, 1.5)));
    const parent = world.getOrCreateEntity(PARENT_EID);
    const child = spawnChild(world, parent, { offset: { x: 1, y: 0.5 }, tag: 0.2 });
    const childAt = (px: number, py: number, angle: number) => ({
      x: px + Math.cos(angle) - 0.5 * Math.sin(angle),
      y: py + Math.sin(angle) + 0.5 * Math.cos(angle),
      angle: angle + 0.2,
    });

    try {
      // At the first server frame the parent is at the origin, unrotated.
      world.progress(100, 0);
      expectPose(child, { x: 1, y: 0.5, angle: 0.2 });

      // Halfway to the next server frame it is at (2, 0), turned by 0.75 radians, and the
      // child, interpolated with it, has already moved and turned with it.
      world.progress(105, 5);
      expect(parent.get(Position)?.x).toBeCloseTo(2, 9);
      expect(parent.get(Rotation)?.angle).toBeCloseTo(0.75, 9);
      expectPose(child, childAt(2, 0, 0.75));
      expectRendered(gameObjectOf(child), childAt(2, 0, 0.75));

      // The second server frame is reached: the child is on its final pose, not a frame behind.
      world.progress(110, 5);
      expectPose(child, childAt(4, 0, 1.5));
      expectRendered(gameObjectOf(child), childAt(4, 0, 1.5));
    } finally {
      world.dispose();
    }
  });
});

const PARENT_EID = 1000;
const POSITION_WIRE_TYPE = phaserNetworkComponents.indexOf(Position) + 1;
const ROTATION_WIRE_TYPE = phaserNetworkComponents.indexOf(Rotation) + 1;

type SocketHandler = (arg?: unknown) => void;

class MemorySocket implements VecsSocket {
  public readonly id = "server";
  private readonly _handlers = new Map<string, SocketHandler[]>();

  public on(event: "connect" | "disconnect" | "receive", handler: SocketHandler): this {
    this._handlers.set(event, [...(this._handlers.get(event) ?? []), handler]);
    return this;
  }

  public send(_data: Uint8Array): void {}

  public close(): void {}

  public receive(data: Uint8Array): void {
    this._handlers.get("receive")?.forEach((handler) => handler(data));
  }
}

function frame(fromFrame: number, toFrame: number, snapshots: EncodedSnapshot[]): Uint8Array {
  return encode(
    new Server2Client({ diff: new StateDiff(testCid, { fromFrame, toFrame, snapshots }) })
  );
}

function parentPose(x: number, y: number, angle: number): EncodedSnapshot[] {
  return [
    snapshot(POSITION_WIRE_TYPE, Object.assign(new Position(), { x, y })),
    snapshot(ROTATION_WIRE_TYPE, Object.assign(new Rotation(), { angle })),
  ];
}

function snapshot(wireType: number, component: object): EncodedSnapshot {
  const payload = encode(component);
  return new EncodedSnapshot(
    encode(new ComponentSnapshot(testCid, { eid: PARENT_EID, wireType, payload })),
    PARENT_EID,
    wireType
  );
}

function encode(message: object): Uint8Array {
  const encoder = new Encoder(new Uint8Array(64 * 1024));
  encoder.write(message);
  return encoder.getBuffer();
}
