import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { compilerOptions } = JSON.parse(readFileSync(`${root}tsconfig.base.json`, "utf8")) as {
  compilerOptions: { paths: Record<string, [string]> };
};

// Cross-package guards load every `@vworlds/*` package from source, resolving
// bare imports through the same `paths` the typecheck uses.
export default defineConfig({
  test: {
    name: "guards",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["**/*.test.ts"],
    pool: "forks",
    // `%HaveSameMap` compares the V8 hidden classes of entities.
    execArgv: ["--allow-natives-syntax"],
    alias: [
      ...Object.entries(compilerOptions.paths).map(([name, [path]]) => ({
        find: new RegExp(`^${name}$`),
        replacement: `${root}${path}`,
      })),
      {
        find: /^phaser$/,
        replacement: `${root}lib/vecs-phaser-client/tests/phaser_stub.ts`,
      },
    ],
  },
});
