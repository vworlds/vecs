import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { World } from "@vworlds/vecs";
import { Router } from "./bridge/router.js";
import { Link } from "./links/link.js";
import { listenLinks } from "./links/listener.js";

/** Node-level MCP configuration. Listening is always explicitly opt-in. */
export interface VecsMcpServerOptions {
  /** Target path prefix; defaults to hostname-pid. Must be one nonempty path segment. */
  name?: string;
  /** Require Authorization: Bearer on MCP requests and the same token in link hello. */
  token?: string;
  /** Reject mutation batches and system enable/disable requests. Defaults to false. */
  readOnly?: boolean;
}

/**
 * Pull-only MCP access to local and linked worlds over Streamable HTTP.
 * The informational package version is resolved lazily, falling back to "unknown"
 * if bundling or unavailable metadata prevents discovery.
 */
export class VecsMcpServer {
  private readonly _router: Router;
  private readonly _token: string | undefined;
  private _http: Server | undefined;
  private _version: string | undefined;
  private readonly _active = new Set<McpServer>();
  private readonly _links = new Set<Link>();
  private _closeLinks?: () => void;

  /** Capture best-effort process and git metadata once; no world hooks are installed. */
  public constructor(options: VecsMcpServerOptions = {}) {
    const name = options.name ?? `${hostname()}-${process.pid}`;
    if (!name || name.includes("/")) {
      throw new Error("Node name must be a nonempty path segment");
    }
    this._token = options.token;
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

  /** Stop HTTP, MCP and all links, including connector retries. Safe to call repeatedly. */
  public async close(): Promise<void> {
    const http = this._http;
    this._http = undefined;
    for (const link of this._links) {
      link.close();
    }
    this._links.clear();
    this._closeLinks?.();
    this._closeLinks = undefined;
    await Promise.all([...this._active].map((server) => server.close()));
    this._active.clear();
    if (http) {
      const closed = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve()))
      );
      http.closeAllConnections();
      await closed;
    }
  }

  /** Listen at /mcp and /link, binding loopback by default. Returns the bound port (0 is ephemeral). */
  public async listen(port: number, host = "127.0.0.1"): Promise<number> {
    if (this._http) {
      throw new Error("VecsMcpServer is already listening");
    }
    const http = createServer((req, res) => {
      void this._handle(req, res);
    });
    this._http = http;
    this._closeLinks = listenLinks(http, this._router, this._token);
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

  /** Register a local world. Uses world.name when available, otherwise "world"; duplicates throw. */
  public registerWorld(world: World, name?: string): void {
    const worldName = "name" in world && typeof world.name === "string" ? world.name : "world";
    this._router.register(world, name ?? worldName);
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
    const server = this._adapter();
    this._active.add(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => {
      this._active.delete(server);
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500).end("MCP request failed");
      } else {
        res.end();
      }
    }
  }

  private _adapter(): McpServer {
    const version = (this._version ??= packageVersion());
    const server = new McpServer({ name: this._router.name, version });
    for (const [name, tool] of Object.entries(tools)) {
      server.registerTool(
        name,
        { description: tool.description, inputSchema: tool.schema },
        async (params: Record<string, unknown>) => {
          const { target, ...rest } = params;
          const response = await this._router.dispatch({
            id: "mcp",
            target: target as string | undefined,
            command: name,
            params: rest,
          });
          if ("error" in response) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: JSON.stringify(response.error) }],
            };
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(response.result) }] };
        }
      );
    }
    return server;
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
  .describe("Full node/world target path; omit only when exactly one target exists.");
const entity = z.union([z.number().int().positive(), z.string()]);
const tools = {
  vecs_targets: {
    description:
      "List the cached aggregate of local and linked targets with originating process/git metadata, via node IDs and world counts. No parameters; no remote requests.",
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
