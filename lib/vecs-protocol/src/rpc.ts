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

/**
 * Reserved {@link RPCError.code} for a call abandoned because no reply arrived
 * in time. Application codes are positive, so a client can tell a transport
 * failure apart from a rejected request without inspecting the message.
 */
export const RPC_TIMEOUT_CODE = -1;

/**
 * Reserved {@link RPCError.code} for a call abandoned because the local session
 * was torn down before a reply arrived — see `ClientWorld.dispose` and
 * `SessionRPC.abortPending`.
 */
export const RPC_CLOSED_CODE = -2;

/** Code used when a handler fails without raising an {@link RPCError}. */
const RPC_UNSPECIFIED_ERROR_CODE = 1;

/**
 * A remote procedure call that failed, carrying a numeric {@link RPCError.code}
 * and a readable message.
 *
 * Throw (or reject with) an `RPCError` from a server RPC handler to fail a call
 * with a code the caller can branch on:
 *
 * ```ts
 * const AUTH_RPC = 101;
 * const AUTH_REJECTED = 4001;
 *
 * world.handleRpc(AUTH_RPC, (_params, _request, ctx) => {
 *   const [resumeToken] = _params as [string];
 *   if (!sessions.authenticate(ctx.connectionId, resumeToken)) {
 *     throw new RPCError(AUTH_REJECTED, "unknown resume token");
 *   }
 * });
 * ```
 *
 * The code and message travel in the response and reach the caller as the
 * rejection value of `invoke`, so a client reads them with `instanceof`:
 *
 * ```ts
 * try {
 *   await client.invoke(AUTH_RPC, [resumeToken]);
 * } catch (error) {
 *   if (error instanceof RPCError && error.code === AUTH_REJECTED) {
 *     console.warn(error.message);
 *   }
 * }
 * ```
 *
 * Handlers may still throw a plain `{ error, message }` object; that shape is
 * unwrapped into an `RPCError` on the wire, and `RPCError.error` aliases
 * `RPCError.code` so existing readers keep working.
 */
export class RPCError extends Error {
  public readonly code: number;

  public constructor(code: number, message: string) {
    super(message);
    this.name = "RPCError";
    this.code = code;
  }

  /** Alias for {@link RPCError.code}, matching the older `{ error }` rejection shape. */
  public get error(): number {
    return this.code;
  }
}

/**
 * Handles an incoming RPC.
 *
 * @typeParam TContext - Caller context handed to the handler as its third
 *   argument. `ServerWorld` supplies a `ServerRPCContext` naming the calling
 *   connection; a client-side handler registered with `ClientWorld.listen` gets
 *   `undefined`, because a client has a single peer.
 * @param params - Decoded positional parameters.
 * @param request - The decoded request message (rpc id, call id, params).
 * @param context - Calling session's context, or `undefined` when there is none.
 * @returns Values to send back. An array is sent as-is, a single value as a
 *   one-element array, and `undefined` as an empty array. Throwing rejects the
 *   call; see {@link RPCError}.
 */
export type RPCHandler<TContext = void> = (
  params: unknown[],
  request: RPC,
  context: TContext
) => Promise<unknown[] | unknown> | unknown[] | unknown;

/** Rejection used for calls abandoned because no reply arrived in time. */
export const RPC_TIMEOUT_ERROR = new RPCError(RPC_TIMEOUT_CODE, "Timeout");

/**
 * One peer's RPC channel: outgoing calls, incoming calls, and the handler table.
 *
 * `ClientWorld` and each `ServerWorld` session own one, so call ids never collide
 * across connections and a reply is only ever matched against the calls of the
 * peer that sent it. Replies are cached for {@link SessionRPC.timeoutTick}'s TTL
 * so a duplicated request re-sends the original response instead of re-running
 * the handler.
 */
export class SessionRPC {
  private _nextCallId = 0;
  private readonly _pending = new Map<number, PendingRPC>();
  private readonly _outbox = new Map<number, RPC>();
  private readonly _cachedReplies = new Map<number, CachedReply>();
  private readonly _handlers = new Map<number, RPCHandler>();

  public constructor(private readonly _defaultTTL = 5000) {}

  /**
   * Register the handler for an incoming `rpcId`, replacing any previous one.
   *
   * @param rpcId - Request id to answer. Ids at or below {@link RPC_RESPONSE_ID}
   *   are reserved for responses and throw.
   * @param handler - Called with the decoded params, the request message, and
   *   `undefined` for the caller context; see {@link RPCHandler}.
   */
  public listen(rpcId: number, handler: RPCHandler): void {
    if (rpcId <= RPC_RESPONSE_ID) {
      throw new Error("RPC handler ids must be positive request ids");
    }
    this._handlers.set(rpcId, handler);
  }

  /**
   * Send a call and resolve with the response message.
   *
   * Rejects with an {@link RPCError} carrying the remote code and message, with
   * {@link RPC_TIMEOUT_ERROR} if {@link SessionRPC.timeoutTick} expires the call
   * first, or with whatever reason {@link SessionRPC.abortPending} was given.
   *
   * @param rpcId - Request id. Ids below {@link FIRST_USER_RPC_ID} are reserved
   *   and throw.
   * @param params - Positional parameters to encode with the call.
   * @param ttl - Milliseconds before the call times out; defaults to the
   *   channel's TTL.
   */
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

  /** Dispatch a batch of decoded incoming RPCs: responses resolve calls, requests run handlers. */
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
      pending.reject(new RPCError(message.error, message.message));
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
      response.error = RPC_UNSPECIFIED_ERROR_CODE;
      response.message = `Unknown RPC id ${message.rpcId}`;
      this._queueResponse(response);
      return;
    }

    try {
      const result = await handler(message.params, message, undefined);
      response.params = Array.isArray(result) ? result : result === undefined ? [] : [result];
    } catch (err) {
      response.error = thrownCode(err);
      response.message = thrownMessage(err);
    }
    this._queueResponse(response);
  }

  private _queueResponse(response: RPC): void {
    this._cachedReplies.set(response.callId, { response, ttl: this._defaultTTL });
    this._outbox.set(response.callId, response);
  }

  /**
   * Age in-flight calls and cached replies by `elapsed` milliseconds, rejecting
   * the calls that run out. Callers own the clock — `ClientWorld` does not tick
   * this, so a client call that is never answered stays pending until the world
   * is disposed.
   *
   * @param elapsed - Milliseconds since the previous tick.
   */
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

  /**
   * Reject every in-flight {@link SessionRPC.invoke} call with `reason` and drop
   * queued outgoing requests.
   *
   * Tear down a channel that is going away with this, so callers awaiting a
   * reply fail fast instead of hanging. Late responses for the abandoned call
   * ids are ignored, and replies still owed by this side are dropped.
   *
   * @param reason - Rejection value for each pending call, typically an
   *   {@link RPCError} with code {@link RPC_CLOSED_CODE}.
   */
  public abortPending(reason: unknown): void {
    this._pending.forEach((pending) => pending.reject(reason));
    this._pending.clear();
    this._outbox.clear();
  }

  /** Number of calls awaiting a response plus responses queued for the peer. */
  public get pendingTotal(): number {
    return this._pending.size + this._outbox.size;
  }

  /** Take the outgoing requests and queued responses, emptying the outbox. */
  public getOutgoing(): RPC[] {
    const outgoing = [...this._pending.values()].map((pending) => pending.request);
    outgoing.push(...this._outbox.values());
    this._outbox.clear();
    return outgoing;
  }
}

function thrownCode(err: unknown): number {
  const code =
    (err as { error?: unknown } | null)?.error ?? (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && Number.isInteger(code) ? code : RPC_UNSPECIFIED_ERROR_CODE;
}

function thrownMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  // A handler that rejects with a plain object still owes the caller a readable
  // message: read its `message` field, else serialize it. `String(err)` alone
  // collapses `{ error, message }` to "[object Object]".
  if (typeof err === "object" && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
    try {
      return JSON.stringify(err) ?? String(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
