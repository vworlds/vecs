import { afterEach, describe, expect, it, vi } from "vitest";
import { createDgramSocket } from "../src/dgram_socket.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createDgramSocket signalling failures with the installed dgram client", () => {
  it("includes the attempted world URL and HTTP 404 in connect's rejection", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    // A 404 fails before allocating a browser peer; no real WebRTC or network is needed.
    const peer = vi.fn(() => {
      throw new Error("unexpected peer allocation");
    });
    vi.stubGlobal("RTCPeerConnection", peer);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const socket = await createDgramSocket({
      host: "game.local",
      port: 8080,
      worldName: "my world/1",
      worldBasePath: "/rtc/v1",
    });
    try {
      await expect(socket.connect()).rejects.toMatchObject({
        message: expect.stringContaining("http://game.local:8080/rtc/v1/my%20world%2F1"),
        cause: expect.objectContaining({ message: expect.stringContaining("status 404") }),
      });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "http://game.local:8080/rtc/v1/my%20world%2F1/connection",
        { method: "POST", headers: { "Content-Type": "application/json" } }
      );
      expect(peer).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });
});
