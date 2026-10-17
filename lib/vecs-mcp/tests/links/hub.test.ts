import { describe, expect, it } from "vitest";
import { startHub } from "../../src/bin/hub.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

describe("hub CLI", () => {
  it("preserves the executable in the root-dist published manifest", async () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const tmp = join(root, ".tmp");
    await mkdir(tmp, { recursive: true });
    const dir = await mkdtemp(join(tmp, "mcp-publish-"));
    try {
      const pkg = join(dir, "vecs-mcp");
      await mkdir(pkg);
      await writeFile(
        join(pkg, "package.json"),
        await readFile(new URL("../../package.json", import.meta.url))
      );
      execFileSync(process.execPath, [join(root, "scripts/prepare-vecs-publish-package.mjs"), pkg]);
      const published = JSON.parse(await readFile(join(pkg, "dist/package.json"), "utf8"));
      expect(published.bin).toEqual({ "vecs-mcp": "./bin/hub.js" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([
    [],
    ["other"],
    ["hub"],
    ["hub", "--port", "-1"],
    ["hub", "--port", "65536"],
    ["hub", "--port", "abc"],
    ["hub", "--port", "0", "--unknown"],
    ["hub", "--port", "0", "extra"],
    ["hub", "--port", "0", "--mount", "http://localhost/link"],
    ["hub", "--port", "0", "--mount", "ws://localhost/wrong"],
  ])("rejects invalid arguments %j", async (...args) => {
    await expect(startHub(args as string[])).rejects.toThrow();
  });

  it("starts a loopback hub with repeated mounts and closes retries", async () => {
    const server = await startHub([
      "hub",
      "--port",
      "0",
      "--name",
      "test-hub",
      "--token",
      "secret",
      "--mount",
      "ws://127.0.0.1:1/link",
      "--mount",
      "ws://127.0.0.1:2/link",
    ]);
    await server.close();
  });
});
