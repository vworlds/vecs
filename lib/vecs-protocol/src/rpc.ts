import { Decoder, Encoder, type IEncodable } from "@vworlds/vecs-wire";

export const RPC_RESPONSE_ID = 0;
export const FIRST_USER_RPC_ID = 101;

/**
 * Largest code an {@link RPC.error} can carry: the field is encoded as `u32`.
 */
const MAX_WIRE_ERROR_CODE = 0xffff_ffff;

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

/**
 * Reserved {@link RPCError.code} for a call abandoned because no reply arrived
 * in time. Local only — it is produced by {@link SessionRPC.timeoutTick} and
 * never travels on the wire. Application codes are positive; codes `≤ 0` are
 * reserved for these local reasons.
 */
export const RPC_TIMEOUT_CODE = -1;

/**
 * Reserved {@link RPCError.code} for a call abandoned because the local session
 * was torn down before a reply arrived — see `ClientWorld.dispose` and
 * `SessionRPC.abortPending`. Local only, for the same reason as
 * {@link RPC_TIMEOUT_CODE}.
 */
export const RPC_CLOSED_CODE = -2;

/**
 * Reserved {@link RPCError.code} for a call that fails without an application
 * code: its handler threw a value that carries no code the wire can transmit (a
 * plain `Error`, a string, or a code outside `[1, 4294967295]`), or the request
 * named an rpc id that has no handler. Unlike {@link RPC_TIMEOUT_CODE} and
 * {@link RPC_CLOSED_CODE}, which are raised locally, the responder sends this
 * one and it travels in the reply.
 */
export const RPC_UNSPECIFIED_ERROR_CODE = 1;

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
 * A handler's code crosses the wire in a `u32` field where `0` means success, so
 * only codes in `[1, 4294967295]` are transmitted as thrown. `0`, negatives, and
 * anything above that range are sent as the unspecified code `1` instead —
 * otherwise `0` would make the caller's `invoke` *resolve* and a negative would
 * wrap. Codes `≤ 0` are reserved anyway: {@link RPC_TIMEOUT_CODE} and
 * {@link RPC_CLOSED_CODE} are raised locally and never travel.
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
 * peer that sent it.
 *
 * A caller that sends {@link SessionRPC.getOutgoing} with every frame re-sends
 * each unanswered request every time, so the same request reaches
 * {@link SessionRPC.process} again and again, in later frames and sometimes
 * twice in one batch. The channel therefore runs a handler **once per call**: a
 * copy that arrives while the handler is still running is ignored and its reply
 * goes out when the handler settles, and a copy that arrives afterwards gets the
 * original reply back instead of re-running the handler.
 *
 * Replies are kept until the caller acknowledges them, not for a time. Each side
 * publishes a low watermark, {@link SessionRPC.settledBelow}, with every frame
 * and hands the one it receives to {@link SessionRPC.setPeerSettledBelow}. A
 * reply is dropped once the peer's watermark passes its call id, and a request
 * below the watermark is ignored as a stale copy of a call the peer already
 * settled. `ClientWorld` and `ServerWorld` carry the watermark in the
 * `rpcSettledBelow` field of every frame; a channel driven by hand has to pass
 * it across itself.
 */
export class SessionRPC {
  private _nextCallId = 0;
  // The peer's low watermark: calls it issued below this id have settled.
  private _peerSettledBelow = 0;
  // Bumped by abortPending, so a handler that started under an earlier peer can tell.
  private _epoch = 0;
  private readonly _pending = new Map<number, PendingRPC>();
  private readonly _outbox = new Map<number, RPC>();
  private readonly _cachedReplies = new Map<number, RPC>();
  // Peer call ids whose handler is running and has not settled yet.
  private readonly _inFlight = new Set<number>();
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

  /**
   * Dispatch a batch of decoded incoming RPCs: responses settle the calls they
   * answer, and requests run their handlers, each call at most once. A request
   * is handled by the first rule that applies:
   *
   * 1. Its call id is below the peer's watermark, see
   *    {@link SessionRPC.setPeerSettledBelow}: ignored, because it is a stale
   *    copy of a call the caller already settled.
   * 2. A reply is cached for it: that reply is queued again.
   * 3. Its handler is still running: ignored, because the reply goes out when
   *    the handler settles.
   * 4. Otherwise the handler runs.
   *
   * Handlers run asynchronously: a call's reply is queued once its handler
   * settles, so it shows up in {@link SessionRPC.getOutgoing} after this method
   * has returned.
   *
   * @param messages - Decoded incoming responses and requests, in arrival order.
   */
  public process(messages: RPC[]): void {
    messages.forEach((message) => {
      if (message.rpcId === RPC_RESPONSE_ID) {
        this._processResponse(message);
      } else {
        void this._processRequest(message);
      }
    });
  }

  /**
   * Record the peer's low watermark, the {@link SessionRPC.settledBelow} it
   * sent with its latest frame, and let go of what it no longer needs.
   *
   * Every call the peer issued with a `callId` below the watermark has settled
   * on its side. Raising the watermark therefore deletes the cached and still
   * unsent replies for those calls, and from then on a request below it is
   * ignored as a stale copy: no handler runs and no reply is sent. A handler
   * that is still running for such a call has its reply discarded when it
   * settles.
   *
   * The watermark only moves forward, because frames can arrive out of order on
   * an unordered transport: a value at or below the current one returns at once,
   * which is the common case. It starts at `0` and is reset to `0` by
   * {@link SessionRPC.abortPending}.
   *
   * @param value - The watermark from the peer's latest frame.
   */
  public setPeerSettledBelow(value: number): void {
    if (value <= this._peerSettledBelow) {
      return;
    }
    this._peerSettledBelow = value;
    for (const callId of this._cachedReplies.keys()) {
      if (callId < value) {
        this._cachedReplies.delete(callId);
      }
    }
    for (const callId of this._outbox.keys()) {
      if (callId < value) {
        this._outbox.delete(callId);
      }
    }
  }

  /**
   * Age in-flight calls by `elapsed` milliseconds, rejecting the ones that run
   * out with {@link RPC_TIMEOUT_ERROR}. A call that times out counts as settled,
   * so {@link SessionRPC.settledBelow} moves past it.
   *
   * Callers own the clock — `ClientWorld` does not tick this, so a client call
   * that is never answered stays pending until the world is disposed. Cached
   * replies are not aged: they stay until the peer's watermark passes them, see
   * {@link SessionRPC.setPeerSettledBelow}.
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
  }

  /**
   * Reject every in-flight {@link SessionRPC.invoke} call with `reason`, drop
   * queued outgoing requests, and forget the peer.
   *
   * Tear down a channel that is going away with this, so callers awaiting a
   * reply fail fast instead of hanging. Late responses for the abandoned call
   * ids are ignored, and replies still owed by this side are dropped.
   *
   * Forgetting the peer means everything this channel learned from it: the
   * watermark goes back to `0`, the cached replies and the record of running
   * handlers are cleared, and a handler that is still running will have its
   * reply discarded when it settles. Call this only when the peer is gone. A
   * channel that talks to a new peer afterwards, as a `ClientWorld` does after a
   * reconnect, would otherwise judge the new peer's calls, which number from `0`
   * again, by the old peer's watermark, or answer one with the old peer's reply.
   * This channel's own call ids are not reset, so
   * {@link SessionRPC.settledBelow} keeps moving forward.
   *
   * @param reason - Rejection value for each pending call, typically an
   *   {@link RPCError} with code {@link RPC_CLOSED_CODE}.
   */
  public abortPending(reason: unknown): void {
    this._pending.forEach((pending) => pending.reject(reason));
    this._pending.clear();
    this._outbox.clear();
    this._peerSettledBelow = 0;
    this._cachedReplies.clear();
    this._inFlight.clear();
    this._epoch++;
  }

  /** Number of calls awaiting a response plus responses queued for the peer. */
  public get pendingTotal(): number {
    return this._pending.size + this._outbox.size;
  }

  /**
   * This channel's low watermark: every call it issued with a `callId` below
   * this value has settled, whether it was answered, rejected, timed out or
   * aborted. It is the smallest call id still pending, or the id the next call
   * will get when none is pending, and it never moves backwards.
   *
   * Send it to the peer with every frame and have the peer pass it to
   * {@link SessionRPC.setPeerSettledBelow}, so the peer can drop the replies it
   * kept for calls that no longer need them. `ClientWorld` and `ServerWorld` put
   * it in the `rpcSettledBelow` field of each frame. It starts at `0`, and
   * reading it takes constant time, so it is cheap to read on every frame.
   */
  public get settledBelow(): number {
    if (this._pending.size === 0) {
      return this._nextCallId;
    }
    // Call ids are assigned in increasing order and a Map iterates in insertion
    // order, so the first pending key is the smallest.
    return this._pending.keys().next().value as number;
  }

  /**
   * Take the outgoing requests and queued responses, emptying the outbox.
   *
   * Requests are not emptied: every call that is still pending is returned each
   * time, so a caller that sends each batch re-sends its unanswered requests
   * until their replies arrive.
   */
  public getOutgoing(): RPC[] {
    const outgoing = [...this._pending.values()].map((pending) => pending.request);
    outgoing.push(...this._outbox.values());
    this._outbox.clear();
    return outgoing;
  }

  private async _processRequest(message: RPC): Promise<void> {
    const { callId } = message;
    if (callId < this._peerSettledBelow) {
      return;
    }
    const cached = this._cachedReplies.get(callId);
    if (cached) {
      this._outbox.set(callId, cached);
      return;
    }
    if (this._inFlight.has(callId)) {
      return;
    }

    const response = new RPC({ rpcId: RPC_RESPONSE_ID, callId });
    const handler = this._handlers.get(message.rpcId);
    if (!handler) {
      response.error = RPC_UNSPECIFIED_ERROR_CODE;
      response.message = `Unknown RPC id ${message.rpcId}`;
      this._queueResponse(response);
      return;
    }

    // Recorded before the handler can yield, so a copy that arrives while it
    // runs, in this batch or a later frame, finds the call already taken.
    this._inFlight.add(callId);
    const epoch = this._epoch;
    try {
      const result = await handler(message.params, message, undefined);
      response.params = Array.isArray(result) ? result : result === undefined ? [] : [result];
    } catch (err) {
      response.error = thrownCode(err);
      response.message = thrownMessage(err);
    }
    if (epoch !== this._epoch) {
      // abortPending forgot the peer this call came from, and its id may now
      // belong to a call of the next peer: touch nothing.
      return;
    }
    this._inFlight.delete(callId);
    if (callId < this._peerSettledBelow) {
      // The caller settled this call while the handler ran, so nobody wants the reply.
      return;
    }
    this._queueResponse(response);
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

  private _queueResponse(response: RPC): void {
    this._cachedReplies.set(response.callId, response);
    this._outbox.set(response.callId, response);
  }
}

/**
 * Map a handler's thrown value onto a code the wire can carry.
 *
 * `RPC.error` is a `u32` with `0` meaning success on the receiving side, so a
 * thrown code of `0` would make the caller's `invoke` resolve as a success, a
 * negative would wrap to a large positive, and anything past `2^32-1` would
 * overflow. Only `[1, 2^32-1]` is transmitted; everything else — including
 * `NaN`, non-integers, and the locally-reserved `≤ 0` codes — becomes the
 * unspecified code so the call still fails.
 */
function thrownCode(err: unknown): number {
  const code =
    (err as { error?: unknown } | null)?.error ?? (err as { code?: unknown } | null)?.code;
  if (
    typeof code !== "number" ||
    !Number.isInteger(code) ||
    code < 1 ||
    code > MAX_WIRE_ERROR_CODE
  ) {
    return RPC_UNSPECIFIED_ERROR_CODE;
  }
  return code;
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
