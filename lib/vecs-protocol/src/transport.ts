export interface VecsSocket {
  readonly id: string;
  on(event: string, handler: (...args: any[]) => void): unknown;
  send(data: Uint8Array): void;
  close(): void;
}

export interface VecsSocketListener {
  on(event: string, handler: (...args: any[]) => void): unknown;
}
