import type { BridgeRequest, Destination, TargetEntry } from "../bridge/router.js";

/** @internal A mounted peer's last advertised table and forwarding endpoint. */
export class Peer implements Destination {
  public constructor(
    public entries: TargetEntry[],
    private readonly _forward: (request: BridgeRequest) => Promise<unknown>
  ) {}

  public paths(): string[] {
    return this.entries.map((entry) => entry.path);
  }

  public dispatch(request: BridgeRequest): Promise<unknown> {
    if (!this.entries.some((entry) => entry.path === request.target)) {
      throw new Error(`Unknown target ${request.target}`);
    }
    return this._forward(request);
  }

  public targets(): TargetEntry[] {
    return this.entries;
  }
}
