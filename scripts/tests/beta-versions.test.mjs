import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { betaPackageNames, betaVersion, setBetaVersions } from "../beta-versions.mjs";

test("branch slug replaces runs without trimming and next patch matches stable bump", () => {
  assert.deepEqual(betaVersion("1.0.55", "Pack/Idle__Keepalive", 7), {
    slug: "pack-idle-keepalive",
    version: "1.0.56-pack-idle-keepalive.7",
  });
  assert.equal(
    betaVersion("2.3.99-old.1", "feature/Ω//test!", 12).version,
    "2.3.100-feature-test-.12"
  );
  assert.equal(betaVersion("1.0.55", "323-beta-releases", 7).slug, "323-beta-releases");
});

test("master, latest, numeric/range tags, invalid versions and run numbers fail closed", () => {
  for (const branch of ["master", "LATEST", "123", "x", "VX", "v1", "!!!", ""]) {
    assert.throws(() => betaVersion("1.2.3", branch, 1));
  }
  for (const run of [0, -1, "1.2", "abc", "01"]) {
    assert.throws(() => betaVersion("1.2.3", "test", run));
  }
  assert.throws(() => betaVersion("not-a-version", "test", 1));
});

test("all nine manifests and prepared dependencies use exact beta pins; external packages unchanged", async () => {
  const root = await mkdtemp(resolve(".beta-version-test-"));
  try {
    for (const name of betaPackageNames) {
      await mkdir(resolve(root, "lib", name), { recursive: true });
      await writeFile(
        resolve(root, "lib", name, "package.json"),
        JSON.stringify({
          name: `@vworlds/${name}`,
          version: "1.0.55",
          dependencies: Object.fromEntries([
            ...betaPackageNames.map((n) => [`@vworlds/${n}`, "^1.0.55"]),
            ["@vworlds/dgram-client", "1.0.13"],
          ]),
          peerDependencies: { "@vworlds/vecs": "*", phaser: "^3" },
        })
      );
    }
    const { version } = await setBetaVersions(root, "pack/idle-keepalive", 7);
    assert.equal(version, "1.0.56-pack-idle-keepalive.7");
    for (const name of betaPackageNames) {
      const path = resolve(root, "lib", name);
      const source = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"));
      assert.equal(source.version, version);
      for (const n of betaPackageNames) assert.equal(source.dependencies[`@vworlds/${n}`], version);
      assert.equal(source.dependencies["@vworlds/dgram-client"], "1.0.13");
      assert.deepEqual(source.peerDependencies, { "@vworlds/vecs": version, phaser: "^3" });
      if (name !== "vecs") {
        execFileSync(process.execPath, ["scripts/prepare-vecs-publish-package.mjs", path]);
        const prepared = JSON.parse(await readFile(resolve(path, "dist/package.json"), "utf8"));
        assert.equal(prepared.version, version);
        assert.deepEqual(prepared.dependencies, source.dependencies);
        assert.deepEqual(prepared.peerDependencies, source.peerDependencies);
      }
    }
    const mismatched = resolve(root, "lib/vecs/package.json");
    await writeFile(mismatched, JSON.stringify({ version: "9.9.9" }));
    await assert.rejects(setBetaVersions(root, "test", 8), /versions must match/);
    assert.equal(JSON.parse(await readFile(mismatched, "utf8")).version, "9.9.9");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
