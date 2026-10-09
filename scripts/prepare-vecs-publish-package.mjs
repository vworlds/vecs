import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const syncedDependencyNames = [
  "@vworlds/vecs",
  "@vworlds/vecs-protocol",
  "@vworlds/vecs-wire",
  "@vworlds/vecs-client",
  "@vworlds/vecs-server",
  "@vworlds/vecs-physics",
  "@vworlds/vecs-phaser",
];
const rootDistPackages = new Set([
  "vecs-client",
  "vecs-physics",
  "vecs-protocol",
  "vecs-server",
  "vecs-phaser",
  "vecs-phaser-server",
  "vecs-phaser-client",
]);
const packageDir = process.argv[2];

if (!packageDir) {
  throw new Error("Usage: node scripts/prepare-vecs-publish-package.mjs <package-dir>");
}

const packageName = basename(packageDir);
const packageJsonPath = join(packageDir, "package.json");
const distDir = join(packageDir, "dist");
const sourcePackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
const dependencies = rewriteDependencies(sourcePackage.dependencies ?? {}, sourcePackage.version);
const rootDist = rootDistPackages.has(packageName);

const publishPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  type: sourcePackage.type,
  main: rootDist ? "./index.js" : `./${packageName}/src/index.js`,
  types: rootDist ? "./index.d.ts" : `./${packageName}/src/index.d.ts`,
  exports: {
    ".": rootDist
      ? {
          types: "./index.d.ts",
          import: "./index.js",
        }
      : {
          types: `./${packageName}/src/index.d.ts`,
          default: `./${packageName}/src/index.js`,
        },
    ...Object.fromEntries(
      Object.entries(sourcePackage.exports ?? {})
        .filter(([subpath]) => subpath !== ".")
        .map(([subpath, target]) => [subpath, rewriteExportTarget(target)])
    ),
  },
  repository: {
    type: "git",
    url: "git+https://github.com/vworlds/vecs.git",
  },
  dependencies,
  peerDependencies: sourcePackage.peerDependencies,
  license: sourcePackage.license,
};

await mkdir(distDir, { recursive: true });
await rm(join(distDir, "vecs"), { recursive: true, force: true });
if (packageName !== "vecs-wire") {
  await rm(join(distDir, "vecs-wire"), { recursive: true, force: true });
}

await writeFile(join(distDir, "package.json"), `${JSON.stringify(publishPackage, null, 2)}\n`);

function rewriteExportTarget(target) {
  if (typeof target === "string") {
    return target.replace(/^\.\/dist\//, "./");
  }
  if (Array.isArray(target)) {
    return target.map(rewriteExportTarget);
  }
  if (target !== null && typeof target === "object") {
    return Object.fromEntries(
      Object.entries(target).map(([condition, value]) => [condition, rewriteExportTarget(value)])
    );
  }
  return target;
}

function rewriteDependencies(dependencies, version) {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => [
      name,
      syncedDependencyNames.includes(name) ? version : range,
    ])
  );
}
