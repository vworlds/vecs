import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Router } from "../bridge/router.js";
import { Link } from "./link.js";

/** @internal WebSocket upgrades and control-frame keepalive on the MCP HTTP listener. */
export function listenLinks(http: Server, router: Router, token?: string): () => void {
  const server = new WebSocketServer({ noServer: true });
  const links = new Set<Link>();
  http.on("upgrade", (request, socket, head) => {
    if (request.url?.split("?")[0] !== "/link") {
      socket.destroy();
      return;
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      const link = new Link(router, token);
      links.add(link);
      let alive = true;
      ws.on("pong", () => {
        alive = true;
      });
      const ping = setInterval(() => {
        if (!alive) {
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, 15_000);
      ws.on("message", (data, binary) => link._receive(binary ? data : data.toString()));
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        clearInterval(ping);
        link._disconnected();
        links.delete(link);
      });
      link._attach(ws);
    });
  });
  return () => {
    for (const link of links) {
      link.close();
    }
    for (const socket of server.clients) {
      socket.terminate();
    }
    server.close();
  };
}
