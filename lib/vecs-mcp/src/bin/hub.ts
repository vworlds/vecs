#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { VecsMcpServer } from "../server.js";

const usage =
  "Usage: vecs-mcp hub --port 4000 [--host h] [--name hub] [--token t] [--mount ws://host/link]…";

/** @internal Start the CLI hub; the caller owns shutdown. Throws on invalid arguments. */
export async function startHub(args: string[]): Promise<VecsMcpServer> {
  if (args[0] !== "hub") {
    throw new Error(usage);
  }
  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      port: { type: "string" },
      host: { type: "string" },
      name: { type: "string" },
      token: { type: "string" },
      mount: { type: "string", multiple: true },
    },
    allowPositionals: false,
  });
  if (!values.port || !/^\d+$/.test(values.port) || Number(values.port) > 65535) {
    throw new Error(usage);
  }
  for (const value of values.mount ?? []) {
    const url = new URL(value);
    if (!["ws:", "wss:"].includes(url.protocol) || url.pathname !== "/link") {
      throw new Error(usage);
    }
  }
  const server = new VecsMcpServer({ name: values.name ?? "hub", token: values.token });
  try {
    await server.listen(Number(values.port), values.host);
    for (const url of values.mount ?? []) {
      server.mount(url);
    }
    return server;
  } catch (error) {
    await server.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startHub(process.argv.slice(2));
    const stop = () => {
      void server.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage);
    process.exitCode = 1;
  }
}
