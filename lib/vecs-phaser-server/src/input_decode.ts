import { Module, POST_LOAD } from "@vworlds/vecs";
import type { InputPayload } from "@vworlds/vecs-phaser";
import { NetworkClient, NetworkInput } from "@vworlds/vecs-server";

/**
 * Typed, sanitized player input decoded from the raw `NetworkInput` blob.
 * Lives on the client's session entity. Server-local — never networked.
 *
 * Game systems read this component instead of touching `NetworkInput`
 * directly; the mask is interpreted with `hasAction` from
 * `@vworlds/vecs-phaser` using the same ordered action list configured on
 * both ends.
 */
export class PlayerInput {
  /** Bitmask of active actions; bit index = index in the configured order. */
  public mask = 0;
  /** Pointer world X in meters. */
  public pointerX = 0;
  /** Pointer world Y in meters (+y up). */
  public pointerY = 0;
  /** Whether the pointer (mouse button / touch) is down. */
  public pointerDown = false;
}

export interface InputDecodeModuleConfig {
  /**
   * Ordered action names — the shared bit assignment. Must match the order
   * configured on the client's `InputCaptureModule` (`Object.keys` of its
   * `actions` map).
   */
  readonly actions: readonly string[];
  /**
   * Clamp for pointer coordinates in meters (|x|, |y| ≤ `pointerRange`).
   * Defaults to 1000. Keeps hostile payloads from injecting absurd values.
   */
  readonly pointerRange?: number;
}

/**
 * Reactively decodes the opaque `NetworkInput` blob into a typed
 * {@link PlayerInput} component on the session entity, sanitizing every
 * field (unknown action bits are masked off, pointer values are checked
 * finite and clamped). Runs in `POST_LOAD` — the taxonomy phase for turning
 * raw loaded data into high-level actions — so gameplay systems in
 * `ON_UPDATE` always see the current tick's input.
 */
export class InputDecodeModule extends Module<InputDecodeModuleConfig> {
  public init(config: InputDecodeModuleConfig): void {
    const world = this.world;
    const validMask = config.actions.length >= 32 ? -1 >>> 0 : (1 << config.actions.length) - 1;
    const pointerRange = config.pointerRange ?? 1000;

    world.component(PlayerInput);

    world
      .system("phaser.input.decode")
      .with(NetworkClient, NetworkInput)
      .phase(POST_LOAD)
      .update({ watch: NetworkInput, onEnter: true }, (entity, networkInput) => {
        const raw = (networkInput.input ?? {}) as Partial<InputPayload>;
        entity.set(PlayerInput, {
          mask: (Number(raw.a) >>> 0) & validMask,
          pointerX: clampFinite(raw.px, pointerRange),
          pointerY: clampFinite(raw.py, pointerRange),
          pointerDown: raw.pd === true,
        });
      });
  }
}

function clampFinite(value: unknown, range: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.min(range, Math.max(-range, n));
}
