import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("publishes the browser entry and preserves optional client/server peers", async () => {
  const root = await mkdtemp(join(tmpdir(), "vecs-mcp-publish-"));
  try {
    const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    // The helper keys root-dist layout by the folder basename.
    const dir = join(root, "vecs-mcp");
    await mkdir(dir);
    await writeFile(join(dir, "package.json"), JSON.stringify(source));
    execFileSync(process.execPath, [
      fileURLToPath(new URL("../../../scripts/prepare-vecs-publish-package.mjs", import.meta.url)),
      dir,
    ]);
    const published = JSON.parse(await readFile(join(dir, "dist/package.json"), "utf8"));
    expect(published.exports["./client"]).toEqual({
      types: "./client.d.ts",
      import: "./client.js",
    });
    expect(published.peerDependencies).toEqual(source.peerDependencies);
    expect(published.peerDependenciesMeta).toEqual({
      "@vworlds/vecs-client": { optional: true },
      "@vworlds/vecs-server": { optional: true },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("supports plain worlds when the optional server peer is genuinely absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "vecs-mcp-optional-"));
  try {
    const entry = join(root, "plain.mjs");
    await build({
      stdin: {
        contents:
          'export { World } from "@vworlds/vecs"; export { Router } from "./src/bridge/router.js";',
        resolveDir: dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: entry,
      plugins: [
        {
          name: "absent-optional-peer",
          setup(builder) {
            builder.onResolve({ filter: /^@vworlds\/vecs-server$/ }, () => ({
              path: "@vecs-test/absent-server-peer",
              external: true,
            }));
          },
        },
      ],
    });
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const { World, Router } = await import(${JSON.stringify(pathToFileURL(entry).href)});
      const world = new World();
      const router = new Router("plain", {});
      router.register(world, "world");
      console.log(JSON.stringify(await router.dispatch({ id: "test", command: "vecs_targets", params: {} })));
      world.dispose();
    `,
      ],
      { encoding: "utf8" }
    );
    expect(JSON.parse(output)).toMatchObject({
      result: { targets: [{ path: "plain/world", kind: "world" }] },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
