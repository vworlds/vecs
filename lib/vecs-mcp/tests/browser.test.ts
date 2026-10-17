import { expect, it } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

it.each(["schema/index.ts", "client.ts"])(
  "bundles %s for browsers without Node or MCP SDK imports",
  async (entry) => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(`../src/${entry}`, import.meta.url))],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      metafile: true,
      tsconfig: fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url)),
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs.some((path) => /vecs-server|modelcontextprotocol|zod|node:/.test(path))).toBe(
      false
    );
    expect(result.outputFiles[0].text).not.toMatch(/from ["']node:/);
  }
);
