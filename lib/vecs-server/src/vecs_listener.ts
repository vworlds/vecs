import { type VecsSocketListener } from "@vworlds/vecs-protocol";
import { type World } from "@vworlds/vecs";
import { VecsServer, type VecsServerOptions } from "./vecs_server.js";
import { worldPath } from "./world_path.js";

export interface VecsListenerOptions extends VecsServerOptions {
  apiBasePath?: string;
}

export class VecsListener {
  private readonly _worlds = new Map<string, VecsServer>();

  public constructor(private readonly _options: VecsListenerOptions = {}) {}

  public registerWorld(name: string, world: World): VecsServer {
    const server = new VecsServer(name, world, this._options);
    this._worlds.set(name, server);
    return server;
  }

  public async listen(app: unknown, dgramOptions: Record<string, unknown> = {}): Promise<void> {
    const { SocketListener } = (await import("@vworlds/dgram-server")) as unknown as {
      SocketListener: new (app: unknown, options: Record<string, unknown>) => VecsSocketListener;
    };
    this._worlds.forEach((serverWorld, name) => {
      const listener = new SocketListener(app, {
        ...dgramOptions,
        label: "dgram",
        apiBasePath: worldPath(this._options.apiBasePath, name),
      });
      serverWorld._attach(listener);
    });
  }
}
