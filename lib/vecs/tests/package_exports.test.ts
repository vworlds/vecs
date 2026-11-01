import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as vecs from "../src/index.js";

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
  it("documents every runtime export", async () => {
    const docsRoot = resolve(repoRoot, "lib/vecs/docs");
    const files: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          await collect(path);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(path);
        }
      }
    };
    await collect(docsRoot);
    files.push(
      resolve(repoRoot, "lib/vecs/README.md"),
      resolve(repoRoot, "lib/vecs/skills/vecs/SKILL.md")
    );
    const documentation = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join(
      "\n"
    );
    const exclusions: Record<string, string> = {};

    const undocumented = Object.keys(vecs).filter(
      (name) =>
        vecs[name as keyof typeof vecs] !== undefined &&
        !documentation.includes(name) &&
        !exclusions[name]
    );
    expect(
      undocumented,
      Object.entries(exclusions)
        .map(([name, reason]) => `${name}: ${reason}`)
        .join("\n")
    ).toEqual([]);
  });

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
