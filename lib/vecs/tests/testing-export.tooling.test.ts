import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("builds the testing subpath for a Node consumer and typechecks registration", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const scratch = join(root, ".tmp");
  await mkdir(scratch, { recursive: true });
  const temp = await mkdtemp(join(scratch, "testing-export-"));
  const pkg = join(temp, "node_modules/@vworlds/vecs");
  try {
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), await readFile(join(root, "lib/vecs/package.json")));
    const tsc = join(root, "node_modules/typescript/bin/tsc");
    execFileSync(
      process.execPath,
      [
        tsc,
        "-p",
        join(root, "lib/vecs/tsconfig.build.json"),
        "--outDir",
        join(pkg, "dist"),
        "--tsBuildInfoFile",
        join(temp, "build.tsbuildinfo"),
      ],
      { timeout: 60_000 }
    );
    await writeFile(join(temp, "package.json"), '{"type":"module"}');
    await writeFile(
      join(temp, "consumer.ts"),
      `
      import { strict as assert } from "node:assert";
      import { expect } from "vitest";
      import { World } from "@vworlds/vecs";
      import { vecsEqualityTester } from "@vworlds/vecs/testing";
      expect.addEqualityTesters([vecsEqualityTester]);
      const result: boolean | undefined = vecsEqualityTester(new World(), {});
      assert.equal(result, false);
    `
    );
    execFileSync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2020",
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        join(temp, "consumer.ts"),
      ],
      { timeout: 60_000 }
    );
    // No Vitest imports: the built helper must also run in plain Node.
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { strict as assert } from "node:assert";
      import { World } from "@vworlds/vecs";
      import { vecsEqualityTester } from "@vworlds/vecs/testing";
      const world = new World();
      assert.equal(vecsEqualityTester(world, world), true);
      assert.equal(vecsEqualityTester(world, {}), false);
      assert.equal(vecsEqualityTester({}, world.entity()), false);
      assert.equal(vecsEqualityTester({}, {}), undefined);
      console.log("consumer passed");
    `,
      ],
      { cwd: temp, encoding: "utf8", timeout: 10_000 }
    );
    expect(output).toContain("consumer passed");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);
