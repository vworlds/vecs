import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Fresh WASM runtime per K: the physics harness does not release its engine worlds.
// Keep the long matrix opt-in and the default npm test smoke subset fast.
for (const k of [1, 2, 3, 4, 8]) {
  const result = spawnSync(
    "npx",
    ["vitest", "run", "tests/render_clock_characterization.test.ts", "--reporter=default"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        RUN_RENDER_CLOCK_MATRIX: "1",
        RENDER_CLOCK_K: String(k),
        NO_COLOR: "1",
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("RENDER_CLOCK_RESULT ")) console.log(line);
  }
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr, result.error ?? "");
    process.exit(result.status ?? 1);
  }
}
