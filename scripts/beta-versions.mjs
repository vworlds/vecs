import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const betaPackageNames = [
  "vecs",
  "vecs-client",
  "vecs-physics",
  "vecs-protocol",
  "vecs-server",
  "vecs-mcp",
  "vecs-wire",
  "vecs-phaser",
  "vecs-phaser-server",
  "vecs-phaser-client",
];

/** Compute a branch dist-tag and next-patch prerelease without changing any files. */
export function betaVersion(base, branch, runNumber) {
  if (!branch || branch === "master") throw new Error("Beta releases require a non-master branch");
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // npm rejects tags that look like version ranges. Never let a beta move latest.
  if (slug === "latest" || /^(?:v?[0-9]+|v?x)$/.test(slug) || !/[a-z0-9]/.test(slug)) {
    throw new Error(`Unsafe npm dist-tag: ${slug}; use a descriptive non-version branch name`);
  }
  if (!/^[1-9][0-9]*$/.test(String(runNumber))) throw new Error("Invalid workflow run number");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(base)) {
    throw new Error(`Unsupported version format: ${base}`);
  }
  const [major, minor, patch] = base.split(".").map((part) => Number.parseInt(part, 10));
  const version = `${major}.${minor}.${patch + 1}-${slug}.${runNumber}`;
  return { slug, version };
}

/** Set all published package versions and exact internal dependency pins in a checkout. */
export async function setBetaVersions(root, branch, runNumber) {
  const packages = await Promise.all(
    betaPackageNames.map(async (name) => {
      const path = resolve(root, "lib", name, "package.json");
      return { path, data: JSON.parse(await readFile(path, "utf8")) };
    })
  );
  const versions = new Set(packages.map(({ data }) => data.version));
  if (versions.size !== 1) throw new Error("vecs package versions must match before bumping");
  const result = betaVersion(packages[0].data.version, branch, runNumber);
  const names = new Set(betaPackageNames.map((name) => `@vworlds/${name}`));
  for (const { path, data } of packages) {
    data.version = result.version;
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const name of Object.keys(data[field] ?? {})) {
        if (names.has(name)) data[field][name] = result.version;
      }
    }
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  }
  return result;
}

if (import.meta.main) {
  const [command, branch, runNumber, base] = process.argv.slice(2);
  let result;
  if (command === "metadata") result = betaVersion(base, branch, runNumber);
  else if (command === "set") result = await setBetaVersions(process.cwd(), branch, runNumber);
  else
    throw new Error("Usage: beta-versions.mjs <set|metadata> <branch> <run-number> [base-version]");
  console.log(`${result.version}\t${result.slug}`);
}
