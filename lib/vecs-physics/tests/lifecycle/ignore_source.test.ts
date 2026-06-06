// Focused verification of the cross-library dependency the pose-sync feedback
// suppression rides on: `Query.ignoreSource(QueryDSL)` (relocated from `System`
// to `Query` by a dev merge — see PROGRESS.md → _Cross-library_). This test
// pins the source-attribution contract independently of the physics package so
// a Vecs-side change to the semantics is caught here rather than in opaque
// pose-sync behaviour.

import { World } from "@vworlds/vecs";
import { describe, expect, it } from "vitest";

class Value {
  n = 0;
}
class Tag {}

describe("Query.ignoreSource source attribution", () => {
  it("drops updates from a tagged source, honours entry-init and outside writes", () => {
    const world = new World();
    world.component(Value);
    world.component(Tag);
    world.addPhase("write");
    world.addPhase("read");

    let readerCount = 0;

    // A tagged system that rewrites Value every frame — the "engine write-back".
    const writer = world
      .system("Writer")
      .phase("write")
      .run(() => {
        target.set(Value, { n: target.get(Value)!.n + 1 });
      });
    writer.entity.add(Tag);

    // The reader ignores any update that originated from a Tag-bearing system.
    world
      .system("Reader")
      .with(Value)
      .phase("read")
      .ignoreSource([Tag])
      .update(Value, () => {
        readerCount++;
      });

    world.start();

    const target = world.entity().set(Value, { n: 0 });

    // Frame 1: the entity enters the reader's query. Entry-time initialization
    // bypasses the silence filter, so the reader observes its initial Value.
    world.progress(0, 16);
    expect(readerCount).toBe(1);

    // Frame 2: only the tagged writer touches Value. Its update is silenced.
    readerCount = 0;
    world.progress(16, 16);
    expect(readerCount).toBe(0);

    // An outside (gameplay) write has no source and is never silenced — even
    // though the tagged writer also fires this frame.
    readerCount = 0;
    target.set(Value, { n: 100 });
    world.progress(32, 16);
    expect(readerCount).toBe(1);
  });
});
