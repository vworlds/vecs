import { expect, it } from "vitest";
import { VecsMcpServer } from "../../src/index.js";

it.each(["join", "mount"] as const)(
  "%s rejects invalid URLs synchronously without scheduling retries",
  async (method) => {
    const server = new VecsMcpServer({ name: "game" });
    try {
      for (const url of [
        "not a URL",
        "http://127.0.0.1/link",
        "https://127.0.0.1/link",
        "ftp://example.com/link",
      ]) {
        expect(() => server[method](url)).toThrow();
      }
    } finally {
      await server.close();
    }
  }
);
