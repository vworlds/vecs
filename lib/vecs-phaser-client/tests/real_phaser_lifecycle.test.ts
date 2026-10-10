/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it("verifies Container teardown and the destroyed flag against installed Phaser", () => {
  // A separate Node process avoids the test alias and browser device initialization.
  // The probe asserts the real classes' behavior and throws on a mismatch.
  execFileSync(process.execPath, [
    fileURLToPath(new URL("./real_phaser_lifecycle.cjs", import.meta.url)),
  ]);
});
