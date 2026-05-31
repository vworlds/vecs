import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as api from "../../src/index.js";
import type { ContactEvent, HitEvent, PhysicsOptions, SensorEvent, Vec2 } from "../../src/index.js";

// Type-only public exports do not appear in Object.keys(api), so typecheck pins
// their presence through this alias while the tests below pin runtime exports.
type PublicTypeExports = [PhysicsOptions, Vec2, ContactEvent, SensorEvent, HitEvent];

type ApiSnapshot = {
  runtimeExports: string[];
  classExports: string[];
  functionExports: string[];
  valueExports: string[];
  typeExports: string[];
};

const APPROVED_API = readApprovedApiSnapshot();
const TYPE_EXPORTS = ["ContactEvent", "HitEvent", "PhysicsOptions", "SensorEvent", "Vec2"];

describe("public API exports", () => {
  it("matches the approved public API snapshot", () => {
    expect(buildApiSnapshot()).toEqual(APPROVED_API);
  });

  it("exports component classes, installPhysics, and BodyType with expected runtime kinds", () => {
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
    expect(parseDocumentedDefaultComponents()).toEqual([...APPROVED_API.classExports].sort());
  });
});

function readApprovedApiSnapshot(): ApiSnapshot {
  return JSON.parse(
    readFileSync(new URL("./exports.approved.json", import.meta.url), "utf8")
  ) as ApiSnapshot;
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
