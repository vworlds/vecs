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

async function open() {
  const server = new VecsMcpServer({ name: "hub" });
  servers.push(server);
  const port = await server.listen(0);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/link`);
  sockets.push(socket);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  const welcome = message(socket);
  socket.send(
    JSON.stringify({ type: "hello", protocol: 1, role: "join", name: "game", nodeId: "game-id" })
  );
  expect(await welcome).toEqual({ type: "welcome", name: "hub", nodeId: expect.any(String) });
  return socket;
}

function message(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    socket.once("message", (data) => resolve(JSON.parse(data.toString())))
  );
}

describe("link listener", () => {
  it("sends JSON pings every idle 15 seconds and terminates after 45 seconds of silence", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const socket = await open();
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    for (let i = 0; i < 2; i++) {
      const ping = message(socket);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await ping).toEqual({ type: "ping" });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    }
    await vi.advanceTimersByTimeAsync(15_000);
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("answers JSON pings and accepts pongs to keep a responsive link alive", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const socket = await open();
    for (let i = 0; i < 4; i++) {
      const ping = message(socket);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await ping).toEqual({ type: "ping" });
      socket.send(JSON.stringify({ type: "pong" }));
      const pong = message(socket);
      socket.send(JSON.stringify({ type: "ping" }));
      expect(await pong).toEqual({ type: "pong" });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    }
  });

  it("counts advertisement traffic as liveness without unnecessary pings", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const socket = await open();
    const received: unknown[] = [];
    socket.on("message", (data) => received.push(JSON.parse(data.toString())));
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      socket.send(
        JSON.stringify({
          type: "advertise",
          node: { name: "game", nodeId: "game-id" },
          targets: [],
        })
      );
      // A control-ping round trip proves the preceding data frame reached the server.
      const pong = new Promise<void>((resolve) => socket.once("pong", resolve));
      socket.ping();
      await pong;
    }
    expect(received).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects binary frames", async () => {
    const socket = await open();
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.send(Buffer.from("{}"));
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
