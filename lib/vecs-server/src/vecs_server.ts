import { type VecsSocketListener } from "@vworlds/vecs-protocol";
import { type World } from "@vworlds/vecs";
import { VecsServerWorld, type VecsServerWorldOptions } from "./vecs_server_world.js";
import { worldPath } from "./world_path.js";

export interface VecsServerOptions extends VecsServerWorldOptions {
  apiBasePath?: string;
}

export class VecsServer {
  private readonly _worlds = new Map<string, VecsServerWorld>();

  public constructor(private readonly _options: VecsServerOptions = {}) {}

  public registerWorld(name: string, world: World): VecsServerWorld {
    const serverWorld = new VecsServerWorld(name, world, this._options);
    this._worlds.set(name, serverWorld);
    return serverWorld;
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
