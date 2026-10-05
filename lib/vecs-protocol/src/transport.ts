export interface ConnectionError extends Error {
  status: number;
  statusText: string;
}

export interface VecsSocketEvents {
  receive: (data: Uint8Array) => void;
  disconnect: () => void;
  connect: (err?: ConnectionError) => void;
}

export interface VecsSocket {
  readonly id: string;
  on<K extends keyof VecsSocketEvents>(event: K, handler: VecsSocketEvents[K]): unknown;
  send(data: Uint8Array): void;
  close(): void;
}

export interface VecsSocketListenerEvents {
  new: (socket: VecsSocket) => void;
}

export interface VecsSocketListener {
  on<K extends keyof VecsSocketListenerEvents>(
    event: K,
    handler: VecsSocketListenerEvents[K]
  ): unknown;
  /**
   * Stop accepting connections and release the listener's transport resources. Optional: a
   * transport that cannot be stopped (for example one mounted on a shared HTTP app) omits it, and
   * `ServerWorld.shutdown` then only stops handing new sockets to the world. A returned promise is
   * awaited.
   */
  close?(): void | Promise<void>;
}
