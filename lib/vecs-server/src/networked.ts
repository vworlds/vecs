export class Networked {}

export class NetworkClient {
  public id = "";
  /**
   * Why the server closed this connection, set immediately before the entity is
   * destroyed. `undefined` while the connection is open and for a peer-initiated
   * disconnect, which the server cannot attribute a reason to. Read it from a
   * `NetworkClient` exit system to log server-side kicks.
   */
  public closeReason: string | undefined = undefined;
}

export class NetworkInput {
  public input: unknown = undefined;
}
