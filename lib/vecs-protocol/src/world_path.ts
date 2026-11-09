/** Default whole world-route prefix, shared by clients, listeners and asset routes. */
export const DEFAULT_WORLD_BASE_PATH = "/rtc/v1/world";

/**
 * Append an encoded world name to the whole world-route prefix.
 * `worldBasePath` replaces the whole default `/rtc/v1/world` prefix, not just `/rtc/v1`.
 * Clients and servers must use the same value; one trailing slash is removed.
 */
export function worldPath(worldBasePath = DEFAULT_WORLD_BASE_PATH, worldName: string): string {
  return `${worldBasePath.replace(/\/$/, "")}/${encodeURIComponent(worldName)}`;
}
