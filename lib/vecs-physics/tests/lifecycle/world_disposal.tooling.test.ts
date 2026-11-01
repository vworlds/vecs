import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("physics world disposal", () => {
  for (const mode of ["empty", "chain", "capacity", "memory"]) {
    it(`bounds the isolated ${mode} regression process`, () => {
      // A synchronous WASM hang cannot be interrupted by a Vitest test timeout.
      // A separate process also keeps an exhausted Box2D world table out of other tests.
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../fixtures/world-disposal.ts", import.meta.url)),
          mode,
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
          },
          timeout: 20_000,
          killSignal: "SIGKILL",
          encoding: "utf8",
        }
      );
      expect({
        error: result.error?.message,
        status: result.status,
        output: result.stdout + result.stderr,
      }).toEqual({
        error: undefined,
        status: 0,
        output: `PASS ${mode}\n`,
      });
    }, 25_000);
  }
});
