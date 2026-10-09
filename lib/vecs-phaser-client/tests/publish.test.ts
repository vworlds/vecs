import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-vecs-publish-package.mjs", import.meta.url)
);

test("publish preparation preserves subpaths and leaves dot-only packages byte-identical", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vecs-publish-"));
  try {
    const dir = join(temp, "vecs-phaser-client");
    await mkdir(dir);
    const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    const prepare = async (exports: object): Promise<string> => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ ...source, exports }));
      execFileSync(process.execPath, [script, dir]);
      return readFile(join(dir, "dist/package.json"), "utf8");
    };
    const baseline = await prepare({ ".": source.exports["."] });
    const prepared = JSON.parse(await prepare(source.exports));
    expect(prepared.exports["./headless"]).toEqual({
      types: "./headless.d.ts",
      import: "./headless.js",
    });
    delete prepared.exports["./headless"];
    expect(`${JSON.stringify(prepared, null, 2)}\n`).toBe(baseline);
    const targets = JSON.parse(
      await prepare({
        ".": source.exports["."],
        "./nested": { import: ["./dist/nested.js", null], default: "./external.js" },
      })
    );
    expect(targets.exports["./nested"]).toEqual({
      import: ["./nested.js", null],
      default: "./external.js",
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
