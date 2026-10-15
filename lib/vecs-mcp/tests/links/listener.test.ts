import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { VecsMcpServer } from "../../src/index.js";

const servers: VecsMcpServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.terminate();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function open(autoPong = true) {
  const server = new VecsMcpServer({ name: "hub" });
  servers.push(server);
  const port = await server.listen(0);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/link`, { autoPong });
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  return socket;
}

describe("link listener", () => {
  it("pings every 15 seconds and terminates an unresponsive transport", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const socket = await open(false);
    const ping = new Promise<void>((resolve) => socket.once("ping", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    await vi.advanceTimersByTimeAsync(15_000);
    await ping;
    expect(socket.readyState).toBe(WebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(15_000);
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("accepts control pongs and keeps a responsive link alive", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const socket = await open(false);
    for (let i = 0; i < 3; i++) {
      const ping = new Promise<void>((resolve) => socket.once("ping", resolve));
      await vi.advanceTimersByTimeAsync(15_000);
      await ping;
      socket.pong();
      // Complete a data round trip so the server has consumed the preceding control pong.
      if (i === 0) {
        const welcome = new Promise<void>((resolve) => socket.once("message", () => resolve()));
        socket.send(
          JSON.stringify({
            type: "hello",
            protocol: 1,
            role: "join",
            name: "game",
            nodeId: "game-id",
          })
        );
        await welcome;
      } else {
        const pong = new Promise<void>((resolve) => socket.once("pong", resolve));
        socket.ping();
        await pong;
      }
      expect(socket.readyState).toBe(WebSocket.OPEN);
    }
  });

  it("rejects binary frames", async () => {
    const socket = await open();
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.send(Buffer.from("{}"));
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
