export const PORT = readPortEnv("PORT", 3000);
export const VECS_HOST = readOptionalStringEnv("VECS_HOST");
export const WEBRTC_UDP_HOST = readOptionalStringEnv("VECS_WEBRTC_UDP_HOST") ?? VECS_HOST;
export const WEBRTC_UDP_PORT = readOptionalPortEnv("VECS_WEBRTC_UDP_PORT");
export const WIDTH = 960;
export const HEIGHT = 540;
export const PIXELS_PER_METER = 100;
export const WORLD_WIDTH = WIDTH / PIXELS_PER_METER;
export const WORLD_HEIGHT = HEIGHT / PIXELS_PER_METER;
export const WORLD_MIN_X = -WORLD_WIDTH / 2;
export const WORLD_MAX_X = WORLD_WIDTH / 2;
export const WORLD_MIN_Y = -WORLD_HEIGHT / 2;
export const WORLD_MAX_Y = WORLD_HEIGHT / 2;
export const GRID_COLUMNS = 3;
export const GRID_ROWS = 3;
export const GRID_CELL_COUNT = GRID_COLUMNS * GRID_ROWS;
export const GRID_CELL_WIDTH = WORLD_WIDTH / GRID_COLUMNS;
export const GRID_CELL_HEIGHT = WORLD_HEIGHT / GRID_ROWS;
export const PLAYER_SIZE = 28 / PIXELS_PER_METER;
export const PLAYER_HALF_SIZE = PLAYER_SIZE / 2;
export const PLAYER_STEP = 7 / PIXELS_PER_METER;
export const SCORE_OFFSET_Y = PLAYER_HALF_SIZE + 0.18;
export const MAX_BALLS = 50;
export const BALL_RADIUS = 12 / PIXELS_PER_METER;
export const ELECTRON_DISTANCE = BALL_RADIUS + 0.13;
export const ELECTRON_SIZE = 0.07;
export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;
export const DT_MS = 1000 / TICK_RATE;

function readOptionalStringEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function readOptionalPortEnv(name: string): number | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : parsePort(name, value);
}

function readPortEnv(name: string, defaultValue: number): number {
  const value = process.env[name];
  return value === undefined || value === "" ? defaultValue : parsePort(name, value);
}

function parsePort(name: string, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}
