import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import type { Router } from "../bridge/router.js";
import { Link } from "./link.js";

/** @internal Origin-filtered WebSocket upgrades; Link handles authentication and liveness. */
export function listenLinks(
  http: Server,
  router: Router,
  token?: string,
  origins: ReadonlySet<string> = new Set()
): () => void {
  const server = new WebSocketServer({ noServer: true });
  const links = new Set<Link>();
  http.on("upgrade", (request, socket, head) => {
    if (request.url?.split("?")[0] !== "/link") {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    server.handleUpgrade(request, socket, head, (ws) => {
      const link = new Link(router, token);
      links.add(link);
      ws.on("message", (data, binary) => link._receive(binary ? data : data.toString()));
      ws.on("error", () => ws.terminate());
      ws.on("close", () => {
        link._disconnected();
        links.delete(link);
      });
      link._attach({ send: (data) => ws.send(data), close: () => ws.terminate() });
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
