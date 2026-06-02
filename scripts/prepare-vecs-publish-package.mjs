import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const bundledInternalPackages = ["@vworlds/vecs-protocol"];
const syncedDependencyNames = ["@vworlds/vecs", "@vworlds/vecs-protocol", "@vworlds/vecs-wire"];
const packageDir = process.argv[2];

if (!packageDir) {
  throw new Error("Usage: node scripts/prepare-vecs-publish-package.mjs <package-dir>");
}

const packageName = basename(packageDir);
const packageJsonPath = join(packageDir, "package.json");
const distDir = join(packageDir, "dist");
const sourcePackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
const bundledInternals = bundledInternalPackages.filter(
  (name) => sourcePackage.dependencies?.[name]
);
const dependencies = rewriteDependencies(sourcePackage.dependencies ?? {}, sourcePackage.version);

const publishPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  type: sourcePackage.type,
  main: packageName === "vecs-physics" ? "./index.js" : `./${packageName}/src/index.js`,
  types: packageName === "vecs-physics" ? "./index.d.ts" : `./${packageName}/src/index.d.ts`,
  exports:
    packageName === "vecs-physics"
      ? {
          ".": {
            types: "./index.d.ts",
            import: "./index.js",
          },
        }
      : {
          ".": {
            types: `./${packageName}/src/index.d.ts`,
            default: `./${packageName}/src/index.js`,
          },
        },
  repository: {
    type: "git",
    url: "git+https://github.com/vworlds/vecs.git",
  },
  dependencies,
  ...(bundledInternals.length > 0 ? { bundleDependencies: bundledInternals } : {}),
  license: sourcePackage.license,
};

await mkdir(distDir, { recursive: true });
await rm(join(distDir, "vecs"), { recursive: true, force: true });
if (packageName !== "vecs-wire") {
  await rm(join(distDir, "vecs-wire"), { recursive: true, force: true });
}

for (const internalName of bundledInternals) {
  const internalPackageName = internalName.slice("@vworlds/".length);
  const internalDistDir = join(distDir, internalPackageName);
  const internalNodeModuleDir = join(distDir, "node_modules", "@vworlds", internalPackageName);
  const internalPackageJson = {
    name: internalName,
    version: sourcePackage.version,
    type: "module",
    main: "./src/index.js",
    types: "./src/index.d.ts",
    exports: {
      ".": {
        types: "./src/index.d.ts",
        default: "./src/index.js",
      },
    },
    license: sourcePackage.license,
  };

  await rm(internalNodeModuleDir, { recursive: true, force: true });
  await mkdir(join(internalNodeModuleDir, ".."), { recursive: true });
  await cp(internalDistDir, internalNodeModuleDir, { recursive: true });
  await writeFile(
    join(internalNodeModuleDir, "package.json"),
    `${JSON.stringify(internalPackageJson, null, 2)}\n`
  );
}

await writeFile(join(distDir, "package.json"), `${JSON.stringify(publishPackage, null, 2)}\n`);

function rewriteDependencies(dependencies, version) {
  return Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => [
      name,
      syncedDependencyNames.includes(name) ? version : range,
    ])
  );
}
