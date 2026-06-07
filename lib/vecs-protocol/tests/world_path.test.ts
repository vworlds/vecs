import { describe, expect, it } from "vitest";
import { worldPath } from "../src/world_path.js";

describe("worldPath", () => {
  it("uses the default base path when none is provided", () => {
    expect(worldPath(undefined, "main")).toBe("/rtc/v1/world/main");
  });

  it("joins a custom base path with the world name", () => {
    expect(worldPath("/api/world", "main")).toBe("/api/world/main");
  });

  it("trims a single trailing slash from the base path", () => {
    expect(worldPath("/api/world/", "main")).toBe("/api/world/main");
  });

  it("url-encodes the world name", () => {
    expect(worldPath("/api/world", "my world/1")).toBe("/api/world/my%20world%2F1");
  });
});
