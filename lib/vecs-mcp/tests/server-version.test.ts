import { beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const lookup = vi.hoisted(() => ({ create: vi.fn(), require: vi.fn() }));
vi.mock("node:module", () => ({ createRequire: lookup.create }));

beforeEach(() => {
  vi.resetModules();
  lookup.create.mockReset();
  lookup.require.mockReset();
});

it.each(["missing", "wrong package", "malformed", "loader unavailable"])(
  "resolves version lazily and never throws when metadata is %s",
  async (scenario) => {
    lookup.require.mockImplementation(() => {
      if (scenario === "missing") {
        throw new Error("manifest unavailable");
      }
      return scenario === "malformed" ? null : { name: "another-package", version: "1" };
    });
    lookup.create.mockImplementation(() => {
      if (scenario === "loader unavailable") {
        throw new Error("loader unavailable");
      }
      return lookup.require;
    });
    const { VecsMcpServer } = await import("../src/server.js");
    expect(lookup.create).not.toHaveBeenCalled();
    const server = new VecsMcpServer({ name: "fallback" });
    const client = new Client({ name: "version-test", version: "1" });
    try {
      const port = await server.listen(0);
      expect(lookup.create).not.toHaveBeenCalled();
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`))
      );
      expect(client.getServerVersion()).toEqual({ name: "fallback", version: "unknown" });
      expect((await client.listTools()).tools).toHaveLength(7);
      expect(lookup.create).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  }
);
