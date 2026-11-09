import { type VecsSocket, worldPath } from "@vworlds/vecs-protocol";

/** Where a dgram socket connects: the `VecsListener` host and the world it serves. */
export interface DgramSocketOptions {
  host: string;
  port: number;
  worldName: string;
  protocol?: "http" | "https";
  /**
   * Replaces the whole `/rtc/v1/world` prefix. Defaults to `DEFAULT_WORLD_BASE_PATH`.
   * Client and server must use the same value.
   */
  worldBasePath?: string;
  rtcConfig?: RTCConfiguration;
}

/** A dgram transport socket, typed for {@link ClientWorld.attachSocket} once `connect()` resolves. */
export interface DgramSocket extends VecsSocket {
  /** Open the data channel; resolves when sends are accepted. Failures name the world URL. */
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
 *   `"http"`, `worldBasePath` replaces the whole `/rtc/v1/world` prefix (client and server
 *   must match), and `rtcConfig` defaults to `{}`.
 * @returns The socket, not yet connected.
 */
export async function createDgramSocket(options: DgramSocketOptions): Promise<DgramSocket> {
  const { ClientSocket } = (await import("@vworlds/dgram-client")) as unknown as {
    ClientSocket: new (url: string, config: RTCConfiguration) => DgramSocket;
  };
  const basePath = worldPath(options.worldBasePath, options.worldName);
  const url = `${options.protocol ?? "http"}://${options.host}:${options.port}${basePath}`;
  const socket = new ClientSocket(url, options.rtcConfig ?? {});
  const connect = socket.connect.bind(socket);
  socket.connect = async () => {
    try {
      await connect();
    } catch (cause) {
      throw Object.assign(new Error(`Failed to connect to ${url}: ${String(cause)}`), { cause });
    }
  };
  return socket;
}
