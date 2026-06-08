import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type PackageJson = {
  exports?: {
    "."?: Record<string, unknown>;
  };
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const publishedPackages = [
  "lib/vecs/package.json",
  "lib/vecs-protocol/package.json",
  "lib/vecs-physics/package.json",
];

const workspaceTestConfigs = [
  {
    path: "lib/vecs-client/vitest.config.ts",
    aliases: {
      "@vworlds/vecs": "lib/vecs/src/index.ts",
      "@vworlds/vecs-protocol": "lib/vecs-protocol/src/index.ts",
      "@vworlds/vecs-wire": "lib/vecs-wire/src/index.ts",
    },
  },
  {
    path: "lib/vecs-physics/vitest.config.ts",
    aliases: {
      "@vworlds/vecs": "lib/vecs/src/index.ts",
    },
  },
  {
    path: "lib/vecs-protocol/vitest.config.ts",
    aliases: {
      "@vworlds/vecs": "lib/vecs/src/index.ts",
      "@vworlds/vecs-wire": "lib/vecs-wire/src/index.ts",
    },
  },
  {
    path: "lib/vecs-server/vitest.config.ts",
    aliases: {
      "@vworlds/vecs": "lib/vecs/src/index.ts",
      "@vworlds/vecs-protocol": "lib/vecs-protocol/src/index.ts",
      "@vworlds/vecs-wire": "lib/vecs-wire/src/index.ts",
    },
  },
];

type VitestConfig = {
  test?: {
    alias?: Record<string, string>;
  };
};

async function readPackageJson(path: string): Promise<PackageJson> {
  const contents = await readFile(resolve(repoRoot, path), "utf8");
  return JSON.parse(contents) as PackageJson;
}

describe("package exports", () => {
  it("does not publish development exports pointing at omitted source files", async () => {
    await Promise.all(
      publishedPackages.map(async (path) => {
        const packageJson = await readPackageJson(path);

        expect(packageJson.exports?.["."]).not.toHaveProperty("development");
      })
    );
  });

  it("runs workspace tests against source packages instead of build output", async () => {
    await Promise.all(
      workspaceTestConfigs.map(async ({ path, aliases }) => {
        const config = (await import(pathToFileURL(resolve(repoRoot, path)).href))
          .default as VitestConfig;
        const expectedAliases = Object.fromEntries(
          Object.entries(aliases).map(([name, sourcePath]) => [name, resolve(repoRoot, sourcePath)])
        );

        expect(config.test?.alias).toMatchObject(expectedAliases);
      })
    );
  });
});
