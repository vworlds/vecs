import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as api from "../../src/index.js";
import type { ContactEvent, HitEvent, PhysicsOptions, SensorEvent, Vec2 } from "../../src/index.js";
import { buildApiSnapshot, type ApiSnapshot } from "../../scripts/api-snapshot-lib.js";

// Type-only public exports do not appear in Object.keys(api), so typecheck pins
// their presence through this alias while the tests below pin runtime exports.
type PublicTypeExports = [PhysicsOptions, Vec2, ContactEvent, SensorEvent, HitEvent];

const APPROVED_API = readApprovedApiSnapshot();
// `PhysicsModule` is the entry point, not a component; `Shape` is an abstract
// interface marker (see Implements) with no instantiable defaults of its own
// — neither has a row in the Defaults table.
const DOCUMENTED_COMPONENT_CLASSES = APPROVED_API.classExports.filter(
  (name) => name !== "PhysicsModule" && name !== "Shape"
);

describe("public API exports", () => {
  it("matches the approved public API snapshot", () => {
    expect(buildApiSnapshot()).toEqual(APPROVED_API);
  });

  it("exports component classes, PhysicsModule, and BodyType with expected runtime kinds", () => {
    for (const name of APPROVED_API.classExports) {
      const value = api[name as keyof typeof api];
      expect(typeof value).toBe("function");
      expect(isClass(value)).toBe(true);
    }

    for (const name of APPROVED_API.functionExports) {
      const value = api[name as keyof typeof api];
      expect(typeof value).toBe("function");
      expect(isClass(value)).toBe(false);
    }

    expect(APPROVED_API.valueExports).toEqual(["BodyType"]);
    expect(api[APPROVED_API.valueExports[0] as keyof typeof api]).toEqual({
      Static: "static",
      Kinematic: "kinematic",
      Dynamic: "dynamic",
    });
  });

  it("keeps docs/components.md component rows in sync with exported component classes", () => {
    expect(parseDocumentedDefaultComponents()).toEqual([...DOCUMENTED_COMPONENT_CLASSES].sort());
  });
});

function readApprovedApiSnapshot(): ApiSnapshot {
  return JSON.parse(
    readFileSync(new URL("./exports.approved.json", import.meta.url), "utf8")
  ) as ApiSnapshot;
}

function parseDocumentedDefaultComponents(): string[] {
  const docs = readFileSync(new URL("../../docs/components.md", import.meta.url), "utf8");
  const section = docs.match(/## Defaults\n\n[\s\S]*?\n\n([\s\S]*?)(?=\n## )/);
  if (!section) {
    throw new Error("docs/components.md is missing its Defaults table");
  }

  return [
    ...new Set(
      section[1]
        .split("\n")
        .filter((line) => line.startsWith("|") && !/^\|\s*-/.test(line))
        .slice(1)
        .map((line) => stripBackticks(line.slice(1, -1).split("|")[0].trim()))
    ),
  ].sort();
}

function stripBackticks(value: string): string {
  return value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1) : value;
}

function isClass(value: unknown): boolean {
  return (
    typeof value === "function" && Function.prototype.toString.call(value).startsWith("class ")
  );
}

void (undefined as unknown as PublicTypeExports);
