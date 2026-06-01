import { readFile, writeFile } from "node:fs/promises";

const packagePaths = [
  "lib/vecs/package.json",
  "lib/vecs-client/package.json",
  "lib/vecs-physics/package.json",
  "lib/vecs-protocol/package.json",
  "lib/vecs-server/package.json",
  "lib/vecs-wire/package.json",
];

const packages = await Promise.all(
  packagePaths.map(async (path) => ({
    path,
    data: JSON.parse(await readFile(path, "utf8")),
  }))
);

const versions = new Set(packages.map(({ data }) => data.version));

if (versions.size !== 1) {
  throw new Error(`vecs package versions must match before bumping: ${[...versions].join(", ")}`);
}

const [major, minor, patch] = packages[0].data.version
  .split(".")
  .map((part) => Number.parseInt(part, 10));

if (![major, minor, patch].every(Number.isInteger)) {
  throw new Error(`Unsupported version format: ${packages[0].data.version}`);
}

const nextVersion = `${major}.${minor}.${patch + 1}`;

for (const pkg of packages) {
  pkg.data.version = nextVersion;

  if (pkg.data.dependencies?.["@vworlds/vecs"]) {
    pkg.data.dependencies["@vworlds/vecs"] = nextVersion;
  }

  await writeFile(pkg.path, `${JSON.stringify(pkg.data, null, 2)}\n`);
}

console.log(nextVersion);
