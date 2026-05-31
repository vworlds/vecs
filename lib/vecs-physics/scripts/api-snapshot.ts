import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { format } from "prettier";

import * as api from "../src/index.js";

type ApiSnapshot = {
  runtimeExports: string[];
  classExports: string[];
  functionExports: string[];
  valueExports: string[];
  typeExports: string[];
};

const SNAPSHOT_FILE = new URL("../tests/api/exports.approved.json", import.meta.url);
const TYPE_EXPORTS = ["ContactEvent", "HitEvent", "PhysicsOptions", "SensorEvent", "Vec2"];

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

function buildApiSnapshot(): ApiSnapshot {
  const entries = Object.entries(api).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const classExports: string[] = [];
  const functionExports: string[] = [];
  const valueExports: string[] = [];

  for (const [name, value] of entries) {
    if (isClass(value)) {
      classExports.push(name);
    } else if (typeof value === "function") {
      functionExports.push(name);
    } else {
      valueExports.push(name);
    }
  }

  return {
    runtimeExports: entries.map(([name]) => name),
    classExports,
    functionExports,
    valueExports,
    typeExports: [...TYPE_EXPORTS].sort(),
  };
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

function isClass(value: unknown): boolean {
  return (
    typeof value === "function" && Function.prototype.toString.call(value).startsWith("class ")
  );
}
