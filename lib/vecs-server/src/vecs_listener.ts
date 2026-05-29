import { type VecsSocketListener } from "@vworlds/vecs-protocol";
import { ServerWorld } from "./server_world.js";
import { worldPath } from "./world_path.js";

export interface VecsListenerOptions {
  apiBasePath?: string;
}

export class VecsListener {
  private readonly _worlds = new Map<string, ServerWorld>();

  public constructor(private readonly _options: VecsListenerOptions = {}) {}

  public registerWorld(world: ServerWorld): ServerWorld {
    this._worlds.set(world.name, world);
    return world;
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
