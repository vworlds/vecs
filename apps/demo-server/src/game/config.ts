/**
 * Tank Arena — tunables and world dimensions.
 *
 * Everything is in METERS with +y up (math convention); the client converts
 * to pixels at its CoordSpace frontier with PIXELS_PER_METER. The arena is
 * deliberately larger than the camera view so server-driven camera follow
 * matters.
 */

/** Server tick rate (Hz) and derived timestep. */
export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const DT_MS = 1000 / TICK_RATE;

/** HTTP port (catalog + WebRTC signaling). */
export const PORT = Number(process.env.PORT ?? 3000);
export const WEBRTC_UDP_PORT = process.env.VECS_WEBRTC_UDP_PORT
  ? Number(process.env.VECS_WEBRTC_UDP_PORT)
  : undefined;
export const WEBRTC_UDP_HOST = process.env.VECS_WEBRTC_UDP_HOST;

/** Arena half-extents in meters (origin at the center). */
export const ARENA_HALF_WIDTH = 12;
export const ARENA_HALF_HEIGHT = 7;

/** The client renders at 100 px/m on a 960×540 canvas → a 9.6×5.4 m view. */
export const PIXELS_PER_METER = 100;

/** Tank body/movement. */
export const TANK_RADIUS = 0.35;
export const TANK_VISUAL_SIZE = 0.8;
export const TANK_FORWARD_SPEED = 3.2;
export const TANK_REVERSE_SPEED = 1.8;
export const TANK_TURN_SPEED = 3.4;
export const TANK_RESPAWN_SECONDS = 2.5;

/** Shells. */
export const SHELL_RADIUS = 0.09;
export const SHELL_VISUAL_SIZE = 0.26;
export const SHELL_SPEED = 7.5;
export const SHELL_LIFETIME_SECONDS = 3;
export const SHELL_COOLDOWN_SECONDS = 0.45;
/** Shell spawn distance from the tank center (clears the shooter's collider). */
export const SHELL_MUZZLE_OFFSET = 0.55;

/** The shared input action order — the client MUST use the same order. */
export const INPUT_ACTIONS = ["left", "right", "up", "down", "fire"] as const;

/** Tileset frames (see scripts/generate-assets.mjs). */
export const TANK_FRAMES = [0, 2, 4, 6] as const;
export const TANK_TINTS = [0x60b450, 0x5a8cdc, 0xd45a50, 0xdcbe50] as const;
export const FRAME_SHELL = 8;
export const FRAME_EXPLOSION = 9;
export const FRAME_SPARK = 13;
export const FRAME_WALL = 14;
export const FRAME_FLOOR = 15;
