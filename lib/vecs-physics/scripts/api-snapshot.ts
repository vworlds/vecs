import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";

import { buildApiSnapshot, type ApiSnapshot } from "./api-snapshot-lib.js";

const SNAPSHOT_FILE = new URL("../tests/api/exports.approved.json", import.meta.url);

const current = buildApiSnapshot();

if (process.argv.includes("--write")) {
  writeFileSync(
    SNAPSHOT_FILE,
    await format(JSON.stringify(current, null, 2), { parser: "json", printWidth: 100 })
  );
  console.log(`Wrote ${SNAPSHOT_FILE.pathname}`);
} else {
  checkApiSnapshot(current);
}

function checkApiSnapshot(currentSnapshot: ApiSnapshot): void {
  if (!existsSync(SNAPSHOT_FILE)) {
    throw new Error(
      `Missing API snapshot. Run npm run api:snapshot -- --write from lib/vecs-physics/.`
    );
  }

  const approved = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8")) as ApiSnapshot;
  const approvedJson = JSON.stringify(approved, null, 2);
  const currentJson = JSON.stringify(currentSnapshot, null, 2);
  if (approvedJson !== currentJson) {
    console.error("Public API differs from tests/api/exports.approved.json.");
    console.error(
      "If this is intentional, run npm run api:snapshot -- --write and commit the updated snapshot."
    );
    console.error(currentJson);
    process.exitCode = 1;
  }
}
