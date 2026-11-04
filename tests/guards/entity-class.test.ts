import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import { Entity, Module, World } from "@vworlds/vecs";

const libRoot = fileURLToPath(new URL("../../lib/", import.meta.url));

type PackageJson = {
  name: string;
  main?: string;
  exports?: Record<string, { import: string }>;
};

/** Every entry point of every `@vworlds/*` package, as its source file. */
async function packageEntries(): Promise<{ name: string; source: string }[]> {
  const entries: { name: string; source: string }[] = [];
  for (const directory of await readdir(libRoot)) {
    const manifest = JSON.parse(
      await readFile(resolve(libRoot, directory, "package.json"), "utf8")
    ) as PackageJson;
    const targets = manifest.exports
      ? Object.entries(manifest.exports).map(([subpath, { import: built }]) => ({
          name: `${manifest.name}${subpath.slice(1)}`,
          path: built.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"),
        }))
      : [{ name: manifest.name, path: manifest.main! }];
    for (const { name, path } of targets) {
      entries.push({ name, source: resolve(libRoot, directory, path) });
    }
  }
  return entries;
}

const haveSameMap = new Function("a", "b", "return %HaveSameMap(a, b)") as (
  a: object,
  b: object
) => boolean;

describe("Entity is the only runtime entity class", () => {
  it("is extended by no exported class of any @vworlds package", async () => {
    const entries = await packageEntries();
    expect(new Set(entries.map(({ name }) => name.split("/").slice(0, 2).join("/"))).size).toBe(
      (await readdir(libRoot)).length
    );
    const subclasses: string[] = [];
    let modules = 0;
    for (const { name, source } of entries) {
      const exports = (await import(pathToFileURL(source).href)) as Record<string, unknown>;
      expect(Object.keys(exports).length, name).toBeGreaterThan(0);
      for (const [exported, value] of Object.entries(exports)) {
        if (typeof value !== "function" || value === Entity) {
          continue;
        }
        if (value.prototype instanceof Entity) {
          subclasses.push(`${name}: ${exported}`);
        }
        if (value.prototype instanceof Module) {
          modules++;
        }
      }
    }
    expect(subclasses).toEqual([]);
    // The walk reaches the packages' module classes, so a miss is not an empty scan.
    expect(modules).toBeGreaterThan(5);
  });

  it("gives plain, definition and module entities one prototype and hidden class", () => {
    class Position {
      x = 0;
    }
    class Feature extends Module {
      public init(): void {}
    }
    const world = new World();
    const entities = [world.entity(), world.component(Position), world.module(Feature).entity];
    for (const entity of entities) {
      expect(Object.getPrototypeOf(entity)).toBe(Entity.prototype);
      expect(haveSameMap(entity, entities[0])).toBe(true);
    }
  });
});
