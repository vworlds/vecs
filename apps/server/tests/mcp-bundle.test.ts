import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("runs the bundled MCP listener in the demo's ESM build configuration", async () => {
  const app = fileURLToPath(new URL("../", import.meta.url));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  await mkdir(join(root, ".tmp"), { recursive: true });
  const tmp = await mkdtemp(join(root, ".tmp/mcp-bundle-"));
  try {
    const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
    const external = [...manifest.scripts.build.matchAll(/--external:(\S+)/g)].map(
      (match: RegExpMatchArray) => match[1]
    );
    const outfile = join(tmp, "listener.mjs");
    await build({
      absWorkingDir: app,
      stdin: {
        contents:
          'import { VecsMcpServer } from "@vworlds/vecs-mcp"; const server = new VecsMcpServer({ name: "bundled" }); await server.listen(0); console.log("listener started"); await server.close();',
        resolveDir: app,
      },
      tsconfig: join(app, "tsconfig.json"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external,
      outfile,
    });
    expect(execFileSync(process.execPath, [outfile], { encoding: "utf8", timeout: 10_000 })).toBe(
      "listener started\n"
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
