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
}
