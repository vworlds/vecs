import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const packagePaths = [
  "lib/vecs",
  "lib/vecs-client",
  "lib/vecs-physics",
  "lib/vecs-protocol",
  "lib/vecs-server",
  "lib/vecs-mcp",
  "lib/vecs-wire",
  "lib/vecs-phaser",
  "lib/vecs-phaser-server",
  "lib/vecs-phaser-client",
];

test("release bump pins synced peer dependencies and publish preparation preserves them", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vecs-release-bump-"));
  try {
    for (const packagePath of packagePaths) {
      const dir = join(temp, packagePath);
      await mkdir(dir, { recursive: true });
      const isMcp = packagePath === "lib/vecs-mcp";
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: `@vworlds/${packagePath.slice("lib/".length)}`,
          version: "1.0.58",
          dependencies: { "@vworlds/vecs-client": "1.0.58" },
          peerDependencies: isMcp
            ? {
                "@vworlds/vecs-client": "^1.0.58",
                "@vworlds/vecs-server": "^1.0.58",
                phaser: "^3.0.0",
              }
            : { phaser: "^3.0.0" },
          peerDependenciesMeta: isMcp
            ? {
                "@vworlds/vecs-client": { optional: true },
                "@vworlds/vecs-server": { optional: true },
              }
            : undefined,
        })
      );
    }

    assert.equal(
      execFileSync(process.execPath, [join(repoRoot, "scripts/bump-vecs-versions.mjs")], {
        cwd: temp,
        encoding: "utf8",
      }).trim(),
      "1.0.59"
    );

    const mcpDir = join(temp, "lib/vecs-mcp");
    const source = JSON.parse(await readFile(join(mcpDir, "package.json"), "utf8"));
    assert.equal(source.dependencies["@vworlds/vecs-client"], "1.0.59");
    assert.deepEqual(source.peerDependencies, {
      "@vworlds/vecs-client": "1.0.59",
      "@vworlds/vecs-server": "1.0.59",
      phaser: "^3.0.0",
    });

    execFileSync(process.execPath, [
      join(repoRoot, "scripts/prepare-vecs-publish-package.mjs"),
      mcpDir,
    ]);
    const prepared = JSON.parse(await readFile(join(mcpDir, "dist/package.json"), "utf8"));
    assert.deepEqual(prepared.peerDependencies, source.peerDependencies);
    assert.deepEqual(prepared.peerDependenciesMeta, source.peerDependenciesMeta);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
