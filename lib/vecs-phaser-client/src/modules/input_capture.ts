import { Module, ON_LOAD } from "@vworlds/vecs";
import type Phaser from "phaser";
import { actionMask, type InputPayload } from "@vworlds/vecs-phaser";
import { CoordSpace } from "../coord_space.js";

/**
 * Snapshot of the most recent captured input, stored as world-global data
 * (`world.get(LocalInput)`). Client-local — never networked. Useful for
 * client-side consumers (virtual joysticks, UI highlights) that want the
 * same view of the input the server receives.
 */
export class LocalInput {
  /** Bitmask of active actions; bit index = index in the configured order. */
  public mask = 0;
  /** Pointer world X in meters. */
  public pointerX = 0;
  /** Pointer world Y in meters (+y up). */
  public pointerY = 0;
  /** Whether the pointer (mouse button / touch) is down. */
  public pointerDown = false;
}

export interface InputCaptureModuleConfig {
  readonly scene: Phaser.Scene;
  /**
   * Action name → Phaser key names/keycodes (e.g. `{ left: ["A", "LEFT"] }`).
   * The **order of the keys of this object is the shared bit assignment** —
   * the server's `InputDecodeModule` must be configured with the same action
   * names in the same order.
   */
  readonly actions: Readonly<Record<string, readonly (string | number)[]>>;
  /** Capture pointer position (in meters) and button state. Default true. */
  readonly pointer?: boolean;
  /** Pixels per meter for the pointer conversion; must match the render module. */
  readonly pixelsPerMeter?: number;
}

/**
 * Captures keyboard + pointer/touch input each tick, packs it into the
 * compact {@link InputPayload}, sends it via `ClientWorld.setInput`, and
 * mirrors it into the {@link LocalInput} world-global component.
 *
 * Keys are Phaser `KeyboardPlugin` keys (`addKey` caches by keycode, so
 * re-initialising on the same scene after a reconnect does not leak
 * listeners). Touch devices simply never press keys; the pointer fields
 * cover taps and drags, so a mobile control scheme can be built on
 * `LocalInput` without extra wiring.
 *
 * Runs in `ON_LOAD` — input is loaded into the ECS before any gameplay or
 * render phase reads it.
 */
export class InputCaptureModule extends Module<InputCaptureModuleConfig> {
  public init(config: InputCaptureModuleConfig): void {
    const world = this.world;
    const scene = config.scene;
    const coords = new CoordSpace(scene, config.pixelsPerMeter);
    const capturePointer = config.pointer !== false;
    const order = Object.keys(config.actions);

    const keysByAction = new Map<string, Phaser.Input.Keyboard.Key[]>();
    for (const [action, keyRefs] of Object.entries(config.actions)) {
      const keyboard = scene.input.keyboard;
      const keys = keyboard
        ? keyRefs.map((ref) => keyboard.addKey(ref as string | number, false))
        : [];
      keysByAction.set(action, keys);
    }

    const setInput = (world as { setInput?: (input: unknown) => void }).setInput?.bind(world);
    world.component(LocalInput);

    world
      .system("phaser.input.capture")
      .phase(ON_LOAD)
      .run(() => {
        const active: string[] = [];
        for (const [action, keys] of keysByAction) {
          if (keys.some((key) => key.isDown)) {
            active.push(action);
          }
        }

        const payload: InputPayload = { a: actionMask(order, active) };
        const local: Partial<LocalInput> = { mask: payload.a };
        if (capturePointer) {
          const pointer = scene.input.activePointer;
          payload.px = coords.mx(pointer.worldX);
          payload.py = coords.my(pointer.worldY);
          payload.pd = pointer.isDown;
          local.pointerX = payload.px;
          local.pointerY = payload.py;
          local.pointerDown = payload.pd;
        }

        setInput?.(payload);
        world.set(LocalInput, local);
      });
  }
}
