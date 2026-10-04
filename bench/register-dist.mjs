// Resolve `@vworlds/vecs*` imports to built `dist` output, so benchmarks run
// the same JavaScript a consumer installs instead of the TypeScript sources.
//
//   node --import ./bench/register-dist.mjs bench/sector-tick.ts
//
// `BENCH_VECS_ROOT` points the resolution at another vecs checkout (for
// example a worktree of the base commit), which is how `bench/compare.ts` runs
// the same benchmark file against two builds.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vecsRoot = resolve(process.env.BENCH_VECS_ROOT || repoRoot);
const entries = new Map();

function distEntry(name) {
  let entry = entries.get(name);
  if (entry === undefined) {
    const candidates = [
      join(vecsRoot, "lib", name, "dist", "index.js"),
      join(vecsRoot, "lib", name, "dist", name, "src", "index.js"),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found === undefined) {
      throw new Error(
        `No build output for @vworlds/${name} under ${vecsRoot}; run \`npm run build\` there first`
      );
    }
    entry = pathToFileURL(found).href;
    entries.set(name, entry);
  }
  return entry;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const match = /^@vworlds\/(vecs(?:-[a-z]+)*)$/.exec(specifier);
    if (match !== null) {
      return { url: distEntry(match[1]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
