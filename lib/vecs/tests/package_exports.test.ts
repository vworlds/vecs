import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
});
