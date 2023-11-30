import "@geckos.io/phaser-on-nodejs";
import {
  ComponentSnapshot,
  ComponentSnapshot,
  EntityType,
  StateDiff,
} from "@vworlds/protocol";
import "phaser";
import { Entity } from "./entities/entity.js";
import { World } from "./world.js";

class TestScene extends Phaser.Scene {
  constructor() {
    super("test-scene");
  }
}

function getTestPhaser() {
  const game = new Phaser.Game({
    type: Phaser.HEADLESS,
    parent: "game",
    backgroundColor: "#33A5E7",
    scale: {
      width: 800,
      height: 600,
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    width: 1280,
    height: 720,
    banner: false,
    audio: { noAudio: true },
    scene: [TestScene],
  });
  return { game, scene: game.scene.getScene("test-scene") };
}

const window: any = global["window"];
window.cancelAnimationFrame = new Function(); // complete the jsdom mock window so tests don't crash
const originalWindowSetTimeout = window.setTimeout;
window.setTimeout = new Function(); // so tests don't get stuck
let activeTests = 0;

function withTestPhaser(cb: (game: Phaser.Game, scene: Phaser.Scene) => void) {
  return function () {
    activeTests++;
    window.setTimeout = originalWindowSetTimeout; // enable original setTimeout during tests
    const { game, scene } = getTestPhaser();
    cb(game, scene);
    game.scene.remove("test-scene");
    game.destroy(false, true);

    activeTests--;
    if (activeTests == 0) {
      // no more tests running, so change setTimeout
      // to a dummy so it does not hang Jest after tests are finished
      window.setTimeout = new Function();
    }
  };
}

function stringState(st: string): ComponentSnapshot {
  const e = new ComponentSnapshot();
  e.param(0).string = st;
  return e;
}

class TestObject extends Entity {
  public static override type: EntityType = EntityType.TEST;
  constructor(testValue: string) {
    super();
    this.state.param(0).string = testValue;
  }

  public get message(): string {
    return this.state.param(0).string || "";
  }

  static scenePreloadCalls: number = 0;
  static sceneCreateCalls: number = 0;
  static createdCalls: number = 0;
  static destroyCalls: number = 0;

  static override scene_preload() {
    this.scenePreloadCalls++;
  }
  static override scene_create() {
    this.sceneCreateCalls++;
  }

  public override create(scene: Phaser.Scene): void {
    super.create(scene);
    TestObject.createdCalls++;
  }

  public override destroy(): void {
    super.destroy();
    TestObject.destroyCalls++;
  }
}

test(
  "test scene preload / create",
  withTestPhaser((game, scene) => {
    const manager = new World(scene);

    manager.register(TestObject);
    expect(TestObject.scenePreloadCalls).toBe(0);
    expect(TestObject.sceneCreateCalls).toBe(0);
    manager.scene_preload();
    expect(TestObject.scenePreloadCalls).toBe(1);
    expect(TestObject.sceneCreateCalls).toBe(0);
    manager.scene_create();
    expect(TestObject.scenePreloadCalls).toBe(1);
    expect(TestObject.sceneCreateCalls).toBe(1);
  })
);

test(
  "test update",
  withTestPhaser((game, scene) => {
    const manager = new World(scene);

    manager.register(TestObject);
    manager.scene_preload();

    const TEST_VALUE_1 = "79";
    const TEST_VALUE_2 = "82";

    // 1.- Test create an entity
    let diff = StateDiff.create({
      from: 0,
      to: 5,
      snapshots: [
        ComponentSnapshot.create({
          id: 1,
          type: TestObject.type,
          state: stringState(TEST_VALUE_1),
        }),
      ],
    });

    let entities = [...manager.getEntities()];
    expect(entities.length).toBe(0);
    expect(TestObject.createdCalls).toBe(0);

    manager.update(diff);

    entities = [...manager.getEntities()];
    expect(TestObject.createdCalls).toBe(1); // created() should have been called
    expect(TestObject.destroyCalls).toBe(0); // destroy() should not have been called
    expect(entities.length).toBe(1); // entities contains 1 instance
    const ent = entities[0];
    expect(ent instanceof TestObject).toBe(true); // and it must be a TestObject
    expect((ent as TestObject).message).toBe(TEST_VALUE_1);

    //2.- Test an update to an existing entity

    diff = StateDiff.create({
      from: 5,
      to: 6,
      snapshots: [
        ComponentSnapshot.create({
          id: 1,
          type: TestObject.type,
          state: stringState(TEST_VALUE_2),
        }),
      ],
    });

    manager.update(diff);

    entities = [...manager.getEntities()];
    expect(TestObject.createdCalls).toBe(1); // should still be 1, since this entity is not new
    expect(TestObject.destroyCalls).toBe(0);
    expect(entities.length).toBe(1);
    expect(entities[0] instanceof TestObject).toBe(true);
    expect((entities[0] as TestObject).message).toBe(TEST_VALUE_2); // should have the new value
    expect(entities[0] === ent).toBe(true);

    // 3.- Send a diff to destroy entity #1

    diff = StateDiff.create({
      from: 6,
      to: 7,
      removed: [1],
    });

    manager.update(diff);

    entities = [...manager.getEntities()];
    expect(TestObject.createdCalls).toBe(1); // should still be 1, since no new entities
    expect(entities.length).toBe(0); // entity deleted
    expect(TestObject.destroyCalls).toBe(1);
  })
);

test(
  "full snapshot",
  withTestPhaser((game, scene) => {
    // full snapshots have the "from" field set to zero or undefined

    const manager = new World(scene);

    manager.register(TestObject);
    manager.scene_preload();

    function GetEntitySnapshot(id: number) {
      return ComponentSnapshot.create({
        id,
        type: TestObject.type,
        state: ComponentSnapshot.create(),
      });
    }

    // 1.- Create some entities with these ids:
    const entityIDs_A = [1, 2, 3];

    let diff = StateDiff.create({
      from: 0,
      to: 5,
      snapshots: entityIDs_A.map(GetEntitySnapshot),
    });

    manager.update(diff); // apply the diff

    // check entities where actually created:
    const entities_A = [...manager.getEntities()];

    // map the entities to IDs and sort to avoid random map ordering:
    const currentEntityIDs_A = entities_A
      .map((ent) => ent.id)
      .sort((a, b) => a - b);
    expect(currentEntityIDs_A).toStrictEqual(entityIDs_A);

    // 2.- Create some entities with other ids:
    const entityIDs_B = [2, 5, 6]; // note the "2"

    // since "from" is set to zero, all existing entities
    // that are not listed in "added" are deleted.
    // Therefore, entities 1 and 3 will be destroyed.
    // but 2 is kept, while 5 and 6 are new.

    diff = StateDiff.create({
      from: 0,
      to: 100,
      snapshots: entityIDs_B.map(GetEntitySnapshot),
    });

    manager.update(diff);

    const entities_B = [...manager.getEntities()];
    const currentEntityIDs_B = entities_B
      .map((ent) => ent.id)
      .sort((a, b) => a - b);
    expect(currentEntityIDs_B).toStrictEqual(entityIDs_B);

    // in fact, entity 2 must be the same object, it was
    // not deleted and then recreated:
    const e2_A = entities_A.find((ent) => ent.id === 2);
    const e2_B = entities_B.find((ent) => ent.id === 2);
    expect(e2_B).toBe(e2_A);
  })
);
