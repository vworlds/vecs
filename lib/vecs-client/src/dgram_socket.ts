import { type VecsSocket, worldPath } from "@vworlds/vecs-protocol";

/** Where a dgram socket connects: the `VecsListener` host and the world it serves. */
export interface DgramSocketOptions {
  host: string;
  port: number;
  worldName: string;
  protocol?: "http" | "https";
  apiBasePath?: string;
  rtcConfig?: RTCConfiguration;
}

/** A dgram transport socket, typed for {@link ClientWorld.attachSocket} once `connect()` resolves. */
export interface DgramSocket extends VecsSocket {
  /** Open the data channel; resolves when sends are accepted. */
  connect(): Promise<void>;
}

/**
 * Create an unconnected `@vworlds/dgram-client` socket for a `VecsListener`-hosted world.
 *
 * Use it to compose a connection that {@link ClientWorld.connectDgram} does not cover: await
 * `connect()`, then pass the socket to {@link ClientWorld.attachSocket}. The dgram client's own
 * `ClientSocket` type does not declare `VecsSocket`, so this is the one place that casts it.
 * The transport is loaded on first call, so importing `@vworlds/vecs-client` does not load it.
 *
 * @param options - `host`, `port` and `worldName` select the world; `protocol` defaults to
 *   `"http"`, `apiBasePath` prefixes the world path, and `rtcConfig` defaults to `{}`.
 * @returns The socket, not yet connected.
 */
export async function createDgramSocket(options: DgramSocketOptions): Promise<DgramSocket> {
  const { ClientSocket } = (await import("@vworlds/dgram-client")) as unknown as {
    ClientSocket: new (url: string, config: RTCConfiguration) => DgramSocket;
  };
  const basePath = worldPath(options.apiBasePath, options.worldName);
  return new ClientSocket(
    `${options.protocol ?? "http"}://${options.host}:${options.port}${basePath}`,
    options.rtcConfig ?? {}
  );
}
