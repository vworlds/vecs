import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { World } from "@vworlds/vecs";
import { Router } from "./bridge/router.js";
import { WATCH_IDLE_MS } from "./bridge/watch.js";
import { Link } from "./links/link.js";
import { listenLinks } from "./links/listener.js";

interface Session {
  owner: string;
  active: number;
  idleOrder: number;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  timer?: ReturnType<typeof setTimeout>;
  subscriptions: Map<string, ReturnType<typeof setTimeout> | undefined>;
  listeners: Map<string, () => void>;
  watches: Map<string, { watch: string; target: string | undefined }>;
  closing?: Promise<void>;
}

/** Node-level MCP configuration. Listening is always explicitly opt-in. */
export interface VecsMcpServerOptions {
  /** Target path prefix; defaults to hostname-pid. Must be one nonempty path segment. */
  name?: string;
  /** Require Authorization: Bearer on MCP requests and the same token in link hello. */
  token?: string;
  /** Exact Origins allowed on /link upgrades. Defaults to none; absent Origin is always allowed. */
  linkOrigins?: readonly string[];
  /** Reject mutation batches and system enable/disable requests. Defaults to false. */
  readOnly?: boolean;
}

/**
 * Session-based MCP access to local, linked and tunneled worlds over Streamable HTTP.
 * Up to 16 sessions are admitted; initialization evicts the longest-idle session,
 * or returns HTTP 503 if all are busy. Idle sessions expire after 30 minutes;
 * notification GET streams do not prevent expiry or eviction.
 * The informational package version is resolved lazily, falling back to "unknown"
 * if bundling or unavailable metadata prevents discovery.
 */
export class VecsMcpServer {
  private readonly _router: Router;
  private readonly _token: string | undefined;
  private readonly _linkOrigins: ReadonlySet<string>;
  private _http: Server | undefined;
  private _version: string | undefined;
  private readonly _sessions = new Map<string, Session>();
  private _idleOrder = 0;
  private readonly _links = new Set<Link>();
  private _closeLinks?: () => void;

  /** Capture best-effort process and git metadata once; no world hooks are installed. */
  public constructor(options: VecsMcpServerOptions = {}) {
    const name = options.name ?? `${hostname()}-${process.pid}`;
    if (!name || name.includes("/")) {
      throw new Error("Node name must be a nonempty path segment");
    }
    this._token = options.token;
    this._linkOrigins = new Set(options.linkOrigins);
    this._router = new Router(
      name,
      {
        name,
        pid: process.pid,
        cwd: process.cwd(),
        branch: git("branch", "--show-current"),
        sha: git("rev-parse", "HEAD"),
      },
      options.readOnly
    );
  }

  /** Stop HTTP, MCP sessions and links; unregister every world and release its queries. Safe to repeat. */
  public async close(): Promise<void> {
    const http = this._http;
    this._http = undefined;
    await Promise.all([...this._sessions.values()].map((session) => this._closeSession(session)));
    for (const local of [...this._router.worlds.values()]) {
      await this.unregisterWorld(local.world);
    }
    for (const link of this._links) {
      link.close();
    }
    this._links.clear();
    this._closeLinks?.();
    this._closeLinks = undefined;
    for (const local of this._router.worlds.values()) {
      local.dispose();
    }
    if (http) {
      const closed = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve()))
      );
      http.closeAllConnections();
      await closed;
    }
  }

  /**
   * Listen at /mcp and /link, binding loopback by default. Returns the bound port (0 is ephemeral).
   * SECURITY: Browser pages can reach loopback. /link refuses Origin headers unless allowed by
   * linkOrigins, but non-browser peers can omit or forge Origin. Use only on private networks;
   * configure a token before exposing the port. Origin filtering is not authentication.
   */
  public async listen(port: number, host = "127.0.0.1"): Promise<number> {
    if (this._http) {
      throw new Error("VecsMcpServer is already listening");
    }
    const http = createServer((req, res) => {
      void this._handle(req, res);
    });
    this._http = http;
    this._closeLinks = listenLinks(http, this._router, this._token, this._linkOrigins);
    try {
      await new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      this._closeLinks?.();
      this._closeLinks = undefined;
      this._http = undefined;
      throw error;
    }
    return (http.address() as { port: number }).port;
  }

  /**
   * Register a local world. Uses world.name when available, otherwise "world";
   * duplicates throw. ServerWorld instances also accept bridge announcements and
   * expose opted-in clients as three-segment targets tracked by connection hooks.
   * Each registration holds a live ComponentDef query until unregisterWorld() or close();
   * topology advertisements are coalesced on setImmediate outside the world's tick.
   */
  public registerWorld(world: World, name?: string): void {
    const worldName = "name" in world && typeof world.name === "string" ? world.name : "world";
    this._router.register(world, name ?? worldName);
  }

  /**
   * Detach a local world's hooks, RPC announcement handler, watches and subscriptions.
   * Attempts to release tunneled watches before dropping their routes. Unknown worlds
   * are a no-op. Removes all aliases of the world. You can register it again without stacking hooks.
   */
  public async unregisterWorld(world: World): Promise<void> {
    const names = [...this._router.worlds]
      .filter(([, local]) => local.world === world)
      .map(([name]) => name);
    const pending: Promise<unknown>[] = [];
    for (const name of names) {
      for (const session of this._sessions.values()) {
        session.listeners.get(name)?.();
        session.listeners.delete(name);
        for (const [uri, timer] of session.subscriptions) {
          if (uri.startsWith(this._uri(name, ""))) {
            clearTimeout(timer);
            session.subscriptions.delete(uri);
          }
        }
        const target = `${this._router.name}/${name}`;
        for (const [key, watch] of session.watches) {
          if (watch.target === target || watch.target?.startsWith(`${target}/`)) {
            if (watch.target !== target) {
              pending.push(
                this._router.dispatch({
                  id: "world-unregister",
                  target: watch.target,
                  command: "vecs_unwatch",
                  params: { watch: watch.watch, _session: session.owner },
                })
              );
            }
            session.watches.delete(key);
          }
        }
      }
    }
    this._router.unregister(world);
    await Promise.all(pending);
  }

  /** Expose this node to a hub. Invalid/non-ws(s) URLs throw; connection failures retry until close(). */
  public join(url: string): Link {
    validateLinkUrl(url);
    const link = new Link(this._router, this._token, { url, role: "join" });
    this._links.add(link);
    return link;
  }

  /** Mount a remote node. Invalid/non-ws(s) URLs throw; connection failures retry until close(). */
  public mount(url: string): Link {
    validateLinkUrl(url);
    const link = new Link(this._router, this._token, { url, role: "mount" });
    this._links.add(link);
    return link;
  }

  private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this._token !== undefined) {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${this._token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.writeHead(401).end("Bearer token required");
        return;
      }
    }
    if (req.url?.split("?")[0] !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }
    const id = req.headers["mcp-session-id"];
    if (id !== undefined && (typeof id !== "string" || !this._sessions.has(id))) {
      res.writeHead(404).end("Unknown MCP session");
      return;
    }
    if (id === undefined && req.method !== "POST") {
      res.writeHead(400).end("MCP session required");
      return;
    }
    let evicted: Promise<void> | undefined;
    if (id === undefined && this._sessions.size >= 16) {
      const idle = [...this._sessions.values()]
        .filter((session) => session.active === 0 && !session.closing)
        .sort((a, b) => a.idleOrder - b.idleOrder)[0];
      if (!idle) {
        res.writeHead(503).end("MCP session cap (16); all sessions are busy");
        return;
      }
      evicted = this._closeSession(idle);
    }
    // Reserve capacity synchronously, including pending initialize requests.
    const session = typeof id === "string" ? this._sessions.get(id)! : this._newSession();
    // A long-lived notification GET is not an in-flight command and must not
    // prevent idle expiry or eviction.
    const active = req.method !== "GET";
    if (active) {
      session.active++;
      clearTimeout(session.timer);
    } else {
      this._touch(session);
    }
    try {
      await evicted;
      if (id === undefined) {
        await session.server.connect(session.transport);
      }
      await session.transport.handleRequest(req, res);
      if (!session.transport.sessionId) {
        await this._closeSession(session);
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end("MCP request failed");
      } else {
        res.end();
      }
      if (id === undefined) {
        await this._closeSession(session);
      }
    } finally {
      if (active && --session.active === 0 && !session.closing) {
        this._touch(session);
      }
    }
  }

  private _closeSession(session: Session): Promise<void> {
    return (session.closing ??= this._disposeSession(session));
  }

  private async _disposeSession(session: Session): Promise<void> {
    this._sessions.delete(session.owner);
    const id = session.transport.sessionId;
    if (id) {
      this._sessions.delete(id);
    }
    clearTimeout(session.timer);
    for (const timer of session.subscriptions.values()) {
      clearTimeout(timer);
    }
    session.subscriptions.clear();
    for (const off of session.listeners.values()) {
      off();
    }
    session.listeners.clear();
    for (const local of this._router.worlds.values()) {
      local.watches.close(session.owner);
    }
    const watches = [...session.watches.values()].filter(({ target }) => {
      const segments = target?.split("/");
      return !(
        segments?.length === 2 &&
        segments[0] === this._router.name &&
        this._router.worlds.has(segments[1])
      );
    });
    session.watches.clear();
    await Promise.all(
      watches.map(({ watch, target }) =>
        this._router.dispatch({
          id: "session-close",
          target,
          command: "vecs_unwatch",
          params: { watch, _session: session.owner },
        })
      )
    );
    await session.server.close();
  }

  private _newSession(): Session {
    const version = (this._version ??= packageVersion());
    const server = new McpServer(
      { name: this._router.name, version },
      { capabilities: { resources: { subscribe: true } } }
    );
    const session: Session = {
      owner: randomUUID(),
      active: 0,
      idleOrder: 0,
      server,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          this._sessions.delete(session.owner);
          this._sessions.set(id, session);
        },
        onsessionclosed: () => {
          void this._closeSession(session);
        },
      }),
      subscriptions: new Map(),
      listeners: new Map(),
      watches: new Map(),
    };
    this._sessions.set(session.owner, session);
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [...this._router.worlds].flatMap(([name, local]) =>
        local.watches.ids(session.owner).map((id) => ({
          uri: this._uri(name, id),
          name: `Watch ${id}`,
          mimeType: "application/json",
        }))
      ),
    }));
    server.server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => {
      const { local, id } = this._resource(session, params.uri, true);
      return {
        contents: [
          {
            uri: params.uri,
            mimeType: "application/json",
            text: JSON.stringify(local.watches.read({ watch: id, _session: session.owner })),
          },
        ],
      };
    });
    server.server.setRequestHandler(SubscribeRequestSchema, async ({ params }) => {
      const { name, local } = this._resource(session, params.uri);
      session.subscriptions.set(params.uri, session.subscriptions.get(params.uri));
      if (!session.listeners.has(name)) {
        session.listeners.set(
          name,
          local.watches.listen((id) => {
            const uri = this._uri(name, id);
            if (!session.subscriptions.has(uri) || session.subscriptions.get(uri)) {
              return;
            }
            session.subscriptions.set(
              uri,
              setTimeout(() => {
                session.subscriptions.set(uri, undefined);
                if (local.watches.owns(id, session.owner)) {
                  void server.server
                    .notification({ method: "notifications/resources/updated", params: { uri } })
                    .catch(() => {});
                } else {
                  session.subscriptions.delete(uri);
                }
              }, 100).unref()
            );
          })
        );
      }
      return {};
    });
    server.server.setRequestHandler(UnsubscribeRequestSchema, async ({ params }) => {
      clearTimeout(session.subscriptions.get(params.uri));
      session.subscriptions.delete(params.uri);
      return {};
    });
    for (const [name, tool] of Object.entries(tools)) {
      server.registerTool(
        name,
        { description: tool.description, inputSchema: tool.schema },
        async (params: Record<string, unknown>) => {
          const { target, ...rest } = params;
          // Remember the actual route at creation; adding another target later must
          // not make session-close cleanup ambiguous for an omitted target.
          const paths =
            target === undefined && ["vecs_watch", "vecs_events", "vecs_unwatch"].includes(name)
              ? [...this._router.destinations.values()].flatMap((destination) =>
                  destination.paths()
                )
              : [];
          const route =
            (target as string | undefined) ?? (paths.length === 1 ? paths[0] : undefined);
          const response = await this._router.dispatch({
            id: "mcp",
            target: route,
            command: name,
            params: { ...rest, _session: session.owner },
          });
          if ("error" in response) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: JSON.stringify(response.error) }],
            };
          }
          if (name === "vecs_watch") {
            if (session.closing) {
              await this._router.dispatch({
                id: "session-close",
                target: route,
                command: "vecs_unwatch",
                params: {
                  watch: (response.result as { watch: string }).watch,
                  _session: session.owner,
                },
              });
            } else {
              const watch = (response.result as { watch: string }).watch;
              session.watches.set(JSON.stringify([route, watch]), { watch, target: route });
            }
          }
          if (name === "vecs_unwatch") {
            session.watches.delete(JSON.stringify([route, rest.watch]));
            for (const uri of session.subscriptions.keys()) {
              const segments = route?.split("/");
              if (
                segments?.length === 2 &&
                segments[0] === this._router.name &&
                uri === this._uri(segments[1], String(rest.watch))
              ) {
                clearTimeout(session.subscriptions.get(uri));
                session.subscriptions.delete(uri);
              }
            }
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(response.result) }] };
        }
      );
    }
    return session;
  }

  private _resource(session: Session, uri: string, expired = false) {
    for (const [name, local] of this._router.worlds) {
      const prefix = this._uri(name, "");
      if (uri.startsWith(prefix)) {
        const id = uri.slice(prefix.length);
        if (local.watches.owns(id, session.owner, expired)) {
          return { name, local, id };
        }
      }
    }
    throw new Error(`Unknown watch resource ${uri}`);
  }

  private _touch(session: Session): void {
    session.idleOrder = ++this._idleOrder;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (session.active === 0) {
        void this._closeSession(session);
      }
    }, WATCH_IDLE_MS).unref();
  }

  private _uri(world: string, id: string): string {
    return `vecs://${encodeURIComponent(this._router.name)}/${encodeURIComponent(world)}/watch/${id}`;
  }
}

function validateLinkUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Link URL must use ws: or wss:");
  }
}

function git(...args: string[]): string | null {
  try {
    return (
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 1000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // Published entrypoints sit beside package.json; workspace src/dist sit below it.
    for (const path of ["./package.json", "../package.json"]) {
      try {
        const pkg = require(path) as { name?: string; version?: string };
        if (pkg.name === "@vworlds/vecs-mcp" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        /* Try the next supported package layout. */
      }
    }
  } catch {
    /* Bundlers may relocate the entrypoint or make a require loader unavailable. */
  }
  return "unknown";
}

const target = z
  .string()
  .optional()
  .describe(
    "Full node/world or node/world/connectionId target path; omit only when exactly one target exists."
  );
const entity = z.union([z.number().int().positive(), z.string()]);
const tools = {
  vecs_watch: {
    description:
      "Create a session-owned reactive query using vecs_find's JSON DSL except filter-only source/children, rejected even when nested; parent/target remain supported. include selects optional component values and update hooks, never narrows membership. maxEvents bounds the event ring (default 1000). Returns watch id and current members, without backfill events.",
    schema: {
      target,
      where: z.unknown(),
      include: z.array(z.string()).optional(),
      maxEvents: z.number().int().positive().default(1000),
    },
  },
  vecs_events: {
    description:
      "Read a session-owned watch log oldest first with seq > since (default 0), limit default 100. Returns events, latest sequence and cumulative dropped count; dropped -1 reports idle expiry once. Refreshes the watch's 30-minute idle deadline.",
    schema: {
      target,
      watch: z.string(),
      since: z.number().int().nonnegative().default(0),
      limit: z.number().int().nonnegative().default(100),
    },
  },
  vecs_unwatch: {
    description:
      "Destroy a session-owned watch's membership query, remove its component hooks and free its event ring. Works on readOnly nodes; remote watches route through the same bridge as local tools.",
    schema: { target, watch: z.string() },
  },
  vecs_targets: {
    description:
      "List the cached aggregate of local and linked world/client targets with originating process/git metadata, via node IDs, world counts and client connection metadata. No parameters; no remote requests.",
    schema: {},
  },
  vecs_components: {
    description:
      "Describe registered component types, traits, relationships and modules, carrier counts and JSON schemas. target: optional full node/world path (omit only with one target). filter: optional case-sensitive name substring.",
    schema: { target, filter: z.string().optional() },
  },
  vecs_find: {
    description:
      "One-shot world.filter query. target: optional node/world path. where: component name, true/false, array (all), or nested all/any/not/only/target/source/parent/children; target/source take [relationship name, query]; test is rejected. include: optional component names whose values to return (default none). limit: nonnegative page size, default 50. offset: nonnegative start index, default 0. Returns total before pagination.",
    schema: {
      target,
      where: z.unknown(),
      include: z.array(z.string()).optional(),
      limit: z.number().int().nonnegative().default(50),
      offset: z.number().int().nonnegative().default(0),
    },
  },
  vecs_entity: {
    description:
      "Dump one entity's components, parent, relationship targets and children. target: optional node/world path. entity: positive numeric eid or Identity name.",
    schema: { target, entity },
  },
  vecs_mutate: {
    description:
      "Statically validate all ops, then apply inline in order between ticks; each op sees previous writes. target: optional node/world path. ops: array of objects with exactly one true action: {create:true,name?:string}, {destroy:true,entity}, {name:true,entity,value:string}, {add:true,entity,component}, {set:true,entity,component,value:object}, {remove:true,entity,component}, {link:true,entity,relationship,to}, {unlink:true,entity,relationship,to}. component/relationship are registered names; entity/to are eids, Identity names or $n (zero-based create index). set.value merges a patch over the current component; entity fields accept eids. Static rejection applies nothing; runtime error returns applied prefix and failing index, no rollback. readOnly or deferred worlds reject the batch.",
    schema: { target, ops: z.array(z.record(z.unknown())) },
  },
  vecs_systems: {
    description:
      "List pipeline systems in order, with phase, enabled state, callbacks, watched components and timings. target: optional node/world path. enable: optional system name to enable. disable: optional system name to disable; both are forbidden on readOnly nodes.",
    schema: { target, enable: z.string().optional(), disable: z.string().optional() },
  },
  vecs_stats: {
    description:
      "Read WorldStats systems and operations timing snapshots. Does not enable collection. target: optional full node/world path; omit only with one target.",
    schema: { target },
  },
};
