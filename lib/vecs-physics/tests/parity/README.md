# Box2D Parity N/A Cases

These Box2D tests are intentionally not ported for v1 because `architecture/ARCHITECTURE.md` lists the underlying features as non-goals: ray casts, shape casts, AABB overlap queries, multithreading, C container helpers, and C API ergonomics.

| Box2D test              | v1 status        | PLAN non-goal reason                                                                                                             |
| ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `RayCastShapeTest`      | Not ported       | Public ray casts are a v1 non-goal.                                                                                              |
| `ShapeCastTest`         | Not ported       | Shape casts are a v1 non-goal.                                                                                                   |
| Threading tests         | Not ported       | v1 is single-threaded and excludes multithreading, SIMD, and scheduler behavior.                                                 |
| Container tests         | Not ported       | Box2D container helpers exist for C; vecs-physics uses TypeScript arrays directly.                                               |
| Hash-set tests          | Not ported       | Box2D hash-set behavior is C container coverage, not a vecs-physics public or engine contract.                                   |
| `TestIsValid`           | Not ported       | Box2D world-id C API validation is outside the Vecs component API.                                                               |
| `TestWorldRecycle`      | Not ported       | Box2D world-id recycling is C API lifecycle behavior; vecs-physics attaches state to a Vecs `World`.                             |
| `TestWorldCoverage`     | Not ported       | Broad C world API coverage exceeds the v1 component-first API surface.                                                           |
| `TestSetWorkerCount`    | Not ported       | Worker-count configuration is multithreading API and v1 is single-threaded.                                                      |
| `ChainSegmentShapeTest` | Partially ported | Physical one-sided chain behavior is covered; C API shape-type mutation is intentionally outside v1 and recorded at M4 closeout. |
