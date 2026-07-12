import { Module, type Entity } from "@vworlds/vecs";

/**
 * A player's tank. Lives on the tank body entity; `session` points back to
 * the owning connection's session entity (for camera shakes and scoring).
 */
export class Tank {
  /** Index into the tank color/frame tables (stable per player). */
  public colorIndex = 0;
  /** Owning session entity. */
  public session!: Entity;
  /** Seconds until the next shot is allowed. */
  public cooldown = 0;
  /** Kills scored by this tank's owner. */
  public score = 0;
}

/** Present while a tank is destroyed; counts down to respawn. */
export class Respawning {
  /** Seconds until the tank comes back. */
  public seconds = 0;
}

/** Component registration for the tanks feature. */
export class TankComponents extends Module {
  public init(): void {
    this.world.component(Tank);
    this.world.component(Respawning);
  }
}
