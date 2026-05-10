import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";

export const RPC_RESPONSE_ID = 0;
export const FIRST_USER_RPC_ID = 101;

export class RPC implements IEncodable {
  public rpcId = 0;
  public callId = 0;
  public params: unknown[] = [];
  public error = 0;
  public message = "";

  public constructor(values?: Partial<RPC>) {
    if (values) {
      Object.assign(this, values);
    }
  }

  public wireEncode(encoder: Encoder): void {
    encoder.write_u32(this.rpcId);
    encoder.write_u32(this.callId);
    encoder.write_u32(this.error);
    encoder.write_string(this.message);
    encoder.write_u32(this.params.length);
    this.params.forEach((param) => encoder.write_any(param));
  }

  public static wireDecode(decoder: Decoder): RPC {
    const rpc = new RPC({
      rpcId: decoder.read_u32(),
      callId: decoder.read_u32(),
      error: decoder.read_u32(),
      message: decoder.read_string(),
    });
    const count = decoder.read_u32();
    for (let i = 0; i < count; i++) {
      rpc.params.push(decoder.read_any());
    }
    return rpc;
  }
}

interface PendingRPC {
  request: RPC;
  resolve(value: RPC): void;
  reject(reason: unknown): void;
  ttl: number;
}

interface CachedReply {
  response: RPC;
  ttl: number;
}

export type RPCHandler = (
  params: unknown[],
  request: RPC
) => Promise<unknown[] | unknown> | unknown[] | unknown;

export const RPC_TIMEOUT_ERROR = { error: -1, message: "Timeout" };

export class SessionRPC {
  private _nextCallId = 0;
  private readonly _pending = new Map<number, PendingRPC>();
  private readonly _outbox = new Map<number, RPC>();
  private readonly _cachedReplies = new Map<number, CachedReply>();
  private readonly _handlers = new Map<number, RPCHandler>();

  public constructor(private readonly _defaultTTL = 5000) {}

  public listen(rpcId: number, handler: RPCHandler): void {
    if (rpcId <= RPC_RESPONSE_ID) {
      throw new Error("RPC handler ids must be positive request ids");
    }
    this._handlers.set(rpcId, handler);
  }

  public invoke(rpcId: number, params: unknown[] = [], ttl = this._defaultTTL): Promise<RPC> {
    if (rpcId < FIRST_USER_RPC_ID) {
      throw new Error(`RPC ids 0-${FIRST_USER_RPC_ID - 1} are reserved`);
    }
    const callId = this._nextCallId++;
    const request = new RPC({ rpcId, callId, params });
    return new Promise((resolve, reject) => {
      this._pending.set(callId, { request, resolve, reject, ttl });
    });
  }

  public process(messages: RPC[]): void {
    messages.forEach((message) => {
      if (message.rpcId === RPC_RESPONSE_ID) {
        this._processResponse(message);
      } else {
        void this._processRequest(message);
      }
    });
  }

  private _processResponse(message: RPC): void {
    const pending = this._pending.get(message.callId);
    if (!pending) {
      return;
    }
    this._pending.delete(message.callId);
    if (message.error) {
      pending.reject({ error: message.error, message: message.message });
      return;
    }
    pending.resolve(message);
  }

  private async _processRequest(message: RPC): Promise<void> {
    const cached = this._cachedReplies.get(message.callId);
    if (cached) {
      this._outbox.set(message.callId, cached.response);
      return;
    }

    const response = new RPC({ rpcId: RPC_RESPONSE_ID, callId: message.callId });
    const handler = this._handlers.get(message.rpcId);
    if (!handler) {
      response.error = 1;
      response.message = `Unknown RPC id ${message.rpcId}`;
      this._queueResponse(response);
      return;
    }

    try {
      const result = await handler(message.params, message);
      response.params = Array.isArray(result) ? result : result === undefined ? [] : [result];
    } catch (err) {
      response.error =
        typeof (err as { error?: unknown })?.error === "number"
          ? (err as { error: number }).error
          : 1;
      response.message = err instanceof Error ? err.message : String(err);
    }
    this._queueResponse(response);
  }

  private _queueResponse(response: RPC): void {
    this._cachedReplies.set(response.callId, { response, ttl: this._defaultTTL });
    this._outbox.set(response.callId, response);
  }

  public timeoutTick(elapsed: number): void {
    this._pending.forEach((pending, callId) => {
      pending.ttl -= elapsed;
      if (pending.ttl <= 0) {
        this._pending.delete(callId);
        pending.reject(RPC_TIMEOUT_ERROR);
      }
    });

    this._cachedReplies.forEach((reply, callId) => {
      reply.ttl -= elapsed;
      if (reply.ttl <= 0) {
        this._cachedReplies.delete(callId);
      }
    });
  }

  public get pendingTotal(): number {
    return this._pending.size + this._outbox.size;
  }

  public getOutgoing(): RPC[] {
    const outgoing = [...this._pending.values()].map((pending) => pending.request);
    outgoing.push(...this._outbox.values());
    this._outbox.clear();
    return outgoing;
  }
}
