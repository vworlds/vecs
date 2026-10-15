import { timingSafeEqual, randomUUID } from "node:crypto";
import {
  BridgeError,
  type BridgeRequest,
  type BridgeResponse,
  type Router,
} from "../bridge/router.js";
import { Peer } from "./peer.js";
import { frameSchema, type Frame } from "./protocol.js";

/** Observable connector lifecycle; close() permanently stops reconnection. */
export type LinkState = "connecting" | "handshake" | "linked" | "backoff" | "closed";

/** @internal The common subset of native and listener WebSockets. */
export interface LinkSocket {
  send(data: string): void;
  close(): void;
}

/** @internal Overrides for deterministic timing tests, not server API options. */
export interface LinkTiming {
  backoff?: number;
  timeout?: number;
}

/** A join or mount link. Connection failures retry forever until explicitly closed. */
export class Link {
  private _state: LinkState = "connecting";
  private _socket?: LinkSocket;
  private _remote?: { name: string; nodeId: string };
  private _peer?: Peer;
  private _exposes = false;
  private _unsubscribe?: () => void;
  private _timer?: ReturnType<typeof setTimeout>;
  private _handshake?: ReturnType<typeof setTimeout>;
  private _attempt = 0;
  private readonly _pending = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** @internal Constructed by VecsMcpServer or the shared HTTP listener. */
  public constructor(
    private readonly _router: Router,
    private readonly _token?: string,
    private readonly _connector?: { url: string; role: "join" | "mount" },
    private readonly _timing: LinkTiming = {}
  ) {
    if (_connector) {
      this._connect();
    }
  }

  /** Current lifecycle state; a rejected handshake enters backoff rather than throwing. */
  public get state(): LinkState {
    return this._state;
  }

  /** Permanently stop this link, remove its targets and reject all in-flight requests. */
  public close(): void {
    if (this._state === "closed") {
      return;
    }
    this._state = "closed";
    clearTimeout(this._timer);
    const socket = this._socket;
    this._detach();
    socket?.close();
  }

  /** @internal Attach either WebSocket implementation during its handshake. */
  public _attach(socket: LinkSocket): void {
    this._socket = socket;
    this._state = "handshake";
    this._handshake = setTimeout(() => socket.close(), 30_000);
    if (this._connector) {
      this._send({
        type: "hello",
        protocol: 1,
        role: this._connector.role,
        name: this._router.name,
        nodeId: this._router.nodeId,
        ...(this._token === undefined ? {} : { token: this._token }),
      });
    }
  }

  /** @internal Reject binary, malformed, wrong-direction and out-of-state frames. */
  public _receive(data: unknown): void {
    try {
      if (typeof data !== "string") {
        throw new Error("Text frame required");
      }
      const frame = frameSchema.parse(JSON.parse(data));
      if (frame.type === "reject" && this._connector && this._state === "handshake") {
        this._socket?.close();
        return;
      }
      if (this._state === "handshake") {
        this._accept(frame);
        return;
      }
      if (this._state !== "linked") {
        throw new Error("Unexpected frame");
      }
      if (frame.type === "advertise" && !this._exposes) {
        this._advertised(frame);
      } else if (frame.type === "request" && this._exposes) {
        void this._answer(frame);
      } else if (frame.type === "response" && !this._exposes) {
        const pending = this._pending.get(frame.id);
        if (!pending) {
          return;
        } // A timed-out response must not tear down a healthy link.
        this._pending.delete(frame.id);
        clearTimeout(pending.timer);
        if (frame.error) {
          pending.reject(new BridgeError(frame.error));
        } else {
          pending.resolve(frame.result);
        }
      } else {
        throw new Error("Unexpected frame direction");
      }
    } catch {
      this._socket?.close();
    }
  }

  /** @internal Remove topology immediately on transport loss and schedule connector retry. */
  public _disconnected(): void {
    this._detach();
    if (this._state === "closed") {
      return;
    }
    if (!this._connector) {
      this._state = "closed";
      return;
    }
    this._state = "backoff";
    const delay =
      this._timing.backoff ??
      Math.min(30_000, 1000 * 2 ** Math.min(this._attempt++, 5) * (1 + Math.random() * 0.2));
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._connect(), delay);
  }

  private _connect(): void {
    if (this._state === "closed") {
      return;
    }
    this._state = "connecting";
    try {
      const socket = new WebSocket(this._connector!.url);
      this._socket = socket;
      socket.onopen = () => {
        if (this._state === "closed") {
          socket.close();
        } else {
          this._attach(socket);
        }
      };
      socket.onmessage = (event) => this._receive(event.data);
      socket.onclose = () => this._disconnected();
      socket.onerror = () => socket.close();
    } catch {
      this._disconnected();
    }
  }

  private _accept(frame: Frame): void {
    if (this._connector) {
      if (frame.type !== "welcome") {
        throw new Error("Expected welcome");
      }
      this._exposes = this._connector.role === "join";
    } else {
      if (frame.type !== "hello") {
        throw new Error("Expected hello");
      }
      const supplied = Buffer.from(frame.token ?? "");
      const expected = Buffer.from(this._token ?? "");
      if (
        this._token !== undefined &&
        (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      ) {
        this._reject("Invalid token");
        return;
      }
      this._exposes = frame.role === "mount";
    }
    if (frame.type !== "hello" && frame.type !== "welcome") {
      throw new Error("Expected handshake");
    }
    // Reserve peer names at hello, even before the first advertisement arrives.
    if (
      frame.name === this._router.name ||
      (!this._exposes && this._router.destinations.has(frame.name))
    ) {
      this._reject("Duplicate name");
      return;
    }
    this._remote = { name: frame.name, nodeId: frame.nodeId };
    if (!this._exposes) {
      this._peer = new Peer([], (request) => this._forward(request));
      this._router.destinations.set(frame.name, this._peer);
    }
    if (!this._connector) {
      this._send({ type: "welcome", name: this._router.name, nodeId: this._router.nodeId });
    }
    clearTimeout(this._handshake);
    this._state = "linked";
    this._attempt = 0;
    if (this._exposes) {
      this._unsubscribe = this._router.onChange(() => this._advertise());
      this._advertise();
    }
  }

  private _reject(reason: string): void {
    if (!this._connector) {
      this._send({ type: "reject", reason });
    }
    this._socket?.close();
  }

  private _advertise(): void {
    const table = this._router.table();
    this._send({
      type: "advertise",
      ...table,
      targets: table.targets.map((entry) => ({
        ...entry,
        path: entry.path.startsWith(`${this._router.name}/`)
          ? entry.path
          : `${this._router.name}/${entry.path}`,
        via: entry.via.includes(this._router.nodeId)
          ? entry.via
          : [...entry.via, this._router.nodeId],
      })),
    });
  }

  private _advertised(frame: Extract<Frame, { type: "advertise" }>): void {
    if (frame.node.name !== this._remote!.name || frame.node.nodeId !== this._remote!.nodeId) {
      throw new Error("Wrong advertising node");
    }
    const entries = frame.targets.filter((entry) => !entry.via.includes(this._router.nodeId));
    if (
      entries.some(
        (entry) =>
          !entry.path.startsWith(`${this._remote!.name}/`) ||
          entry.path.split("/").some((segment) => !segment) ||
          !entry.via.includes(this._remote!.nodeId)
      )
    ) {
      throw new Error("Invalid advertised path or via");
    }
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
      throw new Error("Duplicate target");
    }
    if (JSON.stringify(this._peer!.entries) === JSON.stringify(entries)) {
      return;
    }
    this._peer!.entries = entries;
    this._router.changed();
  }

  private async _answer(frame: Extract<Frame, { type: "request" }>): Promise<void> {
    const socket = this._socket;
    const parts = frame.target.split("/");
    const target =
      parts[0] === this._router.name && parts.length > 2 ? parts.slice(1).join("/") : frame.target;
    const response = await this._router.dispatch({ ...frame, target });
    if (this._socket === socket && this._state === "linked") {
      this._send({ type: "response", ...response } as Frame);
    }
  }

  private _forward(request: BridgeRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(
          new BridgeError({ code: "TIMEOUT", message: "Forwarded request timed out", hops: [] })
        );
      }, this._timing.timeout ?? 30_000);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ type: "request", ...request, id, target: request.target! });
    });
  }

  private _send(frame: Frame | ({ type: "response" } & BridgeResponse)): void {
    try {
      this._socket?.send(JSON.stringify(frame));
    } catch {
      this._socket?.close();
    }
  }

  private _detach(): void {
    clearTimeout(this._handshake);
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._socket = undefined;
    if (this._peer && this._router.destinations.get(this._remote!.name) === this._peer) {
      this._router.destinations.delete(this._remote!.name);
      this._router.changed();
    }
    this._peer = undefined;
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError({ code: "LINK_CLOSED", message: "Link closed", hops: [] }));
    }
    this._pending.clear();
  }
}
