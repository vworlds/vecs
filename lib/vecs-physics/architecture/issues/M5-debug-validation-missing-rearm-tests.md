# M5-debug-validation-missing-rearm-tests

## Description

Two of the six debug validation issue codes lack re-arm tests, while the other four codes have them. This is an inconsistent cross-cutting test coverage pattern.

## Reasoning

The `PhysicsDebugValidation` system (VP-25) deduplicates warnings per `(entity.eid, code)` pair, and re-arms (drops the dedupe entry) when the structure becomes valid so a future relapse can warn again. The test suite for VP-25 verifies re-arm for four of six codes but omits it for two:

- `shape-without-parent-body` — HAS re-arm test
- `dynamic-body-without-density` — **MISSING** re-arm test
- `chain-too-few-points` — HAS re-arm test
- `polygon-invalid` — HAS re-arm test
- `shape-position-on-body` — **MISSING** re-arm test
- `position-on-shape-entity` — HAS re-arm test

The missing tests are not an accident of the implementation — `shape-position-on-body` has a structural difference from the others: its re-arm is achieved by the entity leaving the filter (removing the offending component), not by a structural-fix check within the filter. When the entity leaves the filter, it simply isn't visited, and re-entry into the filter triggers a fresh warn. This is a *different* re-arm mechanism from the other five codes, and that difference is what the test would document and protect.

For `dynamic-body-without-density`, the system has no `dedupe.rearm()` call path in its scan — the scan only ever calls `dedupe.warn()`. If a dynamic body is fixed (density added), the scan stops warning because the condition is false, but the dedupe state is never cleared. The body is still in the filter (it still has `Body`), so a regression (removing density again) should re-warn. Without a re-arm mechanism, the second warning may or may not fire depending on whether the `warnOnce` dedupe entry was ever consumed. This is a potential functional gap, not just a test gap.

## Impacted code

- `src/systems/debug.ts` — `_validateDynamicBodyDensity` (no `dedupe.rearm()` call path)
- `tests/debug/debug_validation.test.ts` — missing re-arm tests for two codes

## Impacted features

- Debug validation re-arm semantics. Users won't notice (debug mode only), but the missing test for `dynamic-body-without-density` may mask a real re-arm bug: if a user fixes a density issue and later regresses, the second warning may be silenced.

## Suggested fix

1. Add a re-arm test for `dynamic-body-without-density`: create a body with zero-density shapes → warn fires → replace with a positive-density shape → warn stops → remove density → warn fires again. This test will fail if the re-arm isn't wired, which should prompt adding the `dedupe.rearm()` call in `_validateDynamicBodyDensity`.

2. Add a re-arm test for `shape-position-on-body`: body entity has ShapePosition → warn fires → remove ShapePosition → warn stops → re-add ShapePosition → warn fires again. This exercises the "entity re-enters the filter" re-arm path and confirms it works.
