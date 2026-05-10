import { beforeEach, vi } from "vitest";

// Silence the registration / phase logs the world emits at construction time.
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
