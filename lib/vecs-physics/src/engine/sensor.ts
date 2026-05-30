// Sensor overlap pass (VP-21c): detect sensor overlaps and record raw
// begin/end sensor events into PhysicsState arrays.
//
// In box2d v3, sensors do NOT generate contacts — they run a completely
// separate overlap pass after the solver (`collide.ts:77` already skips sensor
// pairs at contact-creation time). This module ports that pass faithfully.
//
// Ported from box2d/src/sensor.h + sensor.c:
//   - b2Sensor / b2Visitor record types
//   - b2SensorTask (~135-237)   — per-sensor: swap buffers, AABB query, narrow
//                                 check, sort + dedup overlaps2
//   - b2SensorQueryCallback (~44-120) — rejection rules + b2ShapeDistance check
//   - b2OverlapSensors (~239)   — entry point (serial, no bitset/threading)
//   - b2DestroySensor (~372)    — emit end events + swap-remove sensor record
//
// Omissions / deferrals:
//   - `hits` (b2Sensor.hits TOI queue): CCD is M5 — the field is present as an
//     empty stub to mirror the struct layout; `overlapSensors` never pushes to
//     it. See `SensorRecord.hits` doc-comment.
//   - Multi-threading: box2d runs b2SensorTask in a parallel-for; we run a
//     single serial pass (no worker bitsets needed).
//   - Custom filter callback: not in scope for v1 (no custom filter API).
//
// Engine module boundary: import only from math/, util/, and sibling engine/.

import type { AABB } from "../math/aabb.js";
import { mulTransforms, type Transform } from "../math/transform.js";
import { DISABLED_SET } from "./solver_set.js";
import { DistanceInput, emptySimplexCache, makeProxy, shapeDistance } from "./distance.js";
import { shouldShapesCollide } from "./contact.js";
import type { InternalShape } from "./shape.js";
import type { PhysicsState, SensorTouchEvent } from "./state.js";
import type { Handle } from "../util/handle.js";

// ─── Visitor record (b2Visitor) ───────────────────────────────────────────────

/** One shape that currently overlaps a sensor. Mirrors `b2Visitor` (sensor.h).
 * We use the base `Handle` type (index + generation) rather than a branded
 * `ShapeHandle` — the brand is an API-boundary guard and is not needed here. */
export interface VisitorRecord {
  /** Shape handle index (b2Visitor.shapeId). */
  shapeIndex: number;
  /** Generation captured at detection time (b2Visitor.generation). */
  generation: number;
}

// ─── SensorRecord (b2Sensor) ─────────────────────────────────────────────────

/**
 * Per-sensor state. Mirrors `b2Sensor` from box2d/src/sensor.h.
 *
 * Two double-buffered visitor lists:
 *   - `overlaps1` — visitors from the **previous** step (after the swap).
 *   - `overlaps2` — visitors detected in the **current** step (built fresh).
 * A two-finger sorted merge of overlaps1 vs overlaps2 yields begin/end events
 * each step (box2d sensor.c:~268-366).
 *
 * `hits` mirrors `b2Sensor.hits` (TOI visitor queue for CCD / fast-moving
 * shapes). CCD is M5 — this array is always empty in v1. It is retained here
 * so the struct mirrors box2d's layout and the comment explains the gap.
 */
export interface SensorRecord {
  /** Shape handle index of the sensor shape (b2Sensor.shapeId). */
  shapeIndex: number;
  /** Previous-step overlaps (sorted by shapeIndex). After the double-buffer
   * swap this becomes the "old" set to diff against. */
  overlaps1: VisitorRecord[];
  /** Current-step overlaps (built this step, sorted + deduped). */
  overlaps2: VisitorRecord[];
  /**
   * TOI visitor queue for fast-moving (bullet) shapes (b2Sensor.hits).
   * **CCD is deferred to M5** — this array is always empty in v1.
   * box2d sensor.c:157-164 appends hits here and then merges them into
   * overlaps2 before the broad-phase query; that path is a no-op in v1.
   */
  hits: VisitorRecord[];
}

// ─── SensorStorage ────────────────────────────────────────────────────────────

/**
 * Owns the dense array of per-sensor records. Sensors are stored compactly
 * (swap-remove on destroy) and each sensor shape's `sensorIndex` field tracks
 * its position, mirroring `b2Shape.sensorIndex` in box2d.
 *
 * `create(shapeIndex)` is called by `shape_lifecycle.ts` when a sensor shape
 * is registered; `destroy(state, shapeIndex)` is called when a sensor shape
 * is removed. Both mirror `b2CreateShape` and `b2DestroySensor` (sensor.c).
 */
export class SensorStorage {
  /** Dense array of sensor records (indexed by sensorIndex). */
  public readonly records: SensorRecord[] = [];

  /** Total number of live sensor records. */
  public get count(): number {
    return this.records.length;
  }

  /**
   * Create a new sensor record for `shapeIndex` and return its dense-array
   * index. Mirrors the sensor-creation path inside `b2CreateShape`
   * (shape.c:~215-220). Sets `InternalShape.sensorIndex` to the returned
   * index — the caller must do so itself (we receive only a shape index
   * to keep the storage layer agnostic of `InternalShape` details).
   */
  public create(shapeIndex: number): number {
    const record: SensorRecord = {
      shapeIndex,
      overlaps1: [],
      overlaps2: [],
      hits: [],
    };
    this.records.push(record);
    return this.records.length - 1;
  }

  /**
   * Destroy the sensor record at `sensorIndex`, swap-removing it from the
   * dense array. Mirrors `b2DestroySensor` (sensor.c:372-409): emits end
   * events for every currently-overlapping visitor (overlaps2), then frees
   * the slot by swap-remove. The caller must have already written the end
   * events to `state.sensorEndEvents` before calling this — or pass `state`
   * here if we want to centralise the emit.
   *
   * If the swap-remove moved a sensor (movedSensor), the shape whose
   * `sensorIndex` pointed to the old last slot must have its `sensorIndex`
   * patched. Mirrors:
   *   ```c
   *   int movedIndex = b2Array_RemoveSwap(world->sensors, sensorShape->sensorIndex);
   *   if (movedIndex != B2_NULL_INDEX) {
   *     b2Shape* otherSensorShape = b2Array_Get(world->shapes, movedSensor->shapeId);
   *     otherSensorShape->sensorIndex = sensorShape->sensorIndex;
   *   }
   *   ```
   * Returns the old last-slot `shapeIndex` if a move happened (caller must
   * patch that shape's `sensorIndex`), or -1 when no move was needed.
   */
  public destroy(sensorIndex: number): number {
    const last = this.records.length - 1;
    if (sensorIndex === last) {
      // Simple pop — no fixup needed.
      this.records.pop();
      return -1;
    }
    // Swap-remove: copy the last record into the freed slot.
    const moved = this.records[last]!;
    this.records[sensorIndex] = moved;
    this.records.pop();
    // Return the moved record's shapeIndex so the caller can fix the pointer.
    return moved.shapeIndex;
  }
}

// ─── makeShapeDistanceProxy (b2MakeShapeDistanceProxy) ───────────────────────

/**
 * Build a `ShapeProxy` for GJK from an `InternalShape`.
 * Mirrors `b2MakeShapeDistanceProxy` (shape.c:1024-1045).
 *
 * Per-kind:
 *   circle    → 1 point at (cx, cy), radius = circle.radius
 *   capsule   → 2 points (a, b), radius = capsule.radius
 *   segment   → 2 points (a, b), radius = 0
 *   polygon   → all count vertices, radius = polygon.radius
 *   chainSeg  → 2 points (a, b) of the segment, radius = 0
 */
function makeShapeDistanceProxy(shape: InternalShape): ReturnType<typeof makeProxy> {
  const g = shape.geometry;
  switch (g.kind) {
    case "circle":
      return makeProxy([{ x: g.cx, y: g.cy }], 1, g.radius);
    case "capsule":
      return makeProxy(
        [
          { x: g.ax, y: g.ay },
          { x: g.bx, y: g.by },
        ],
        2,
        g.radius
      );
    case "segment":
      return makeProxy(
        [
          { x: g.ax, y: g.ay },
          { x: g.bx, y: g.by },
        ],
        2,
        0
      );
    case "chainSegment":
      return makeProxy(
        [
          { x: g.ax, y: g.ay },
          { x: g.bx, y: g.by },
        ],
        2,
        0
      );
    case "polygon": {
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < g.count; i++) {
        pts.push({ x: g.vertices[i * 2]!, y: g.vertices[i * 2 + 1]! });
      }
      return makeProxy(pts, g.count, g.radius);
    }
  }
}

// ─── _getBodyTransform helper ─────────────────────────────────────────────────

/** Read the current world transform from the sim for a shape's owning body. */
function getBodyTransformForShape(state: PhysicsState, shape: InternalShape): Transform {
  const bodyRec = state.bodies.get(shape.bodyHandle.index);
  const sim = state.solverSets[bodyRec.setIndex]!.bodySims[bodyRec.localIndex]!;
  return { p: { x: sim.transformX, y: sim.transformY }, q: { c: sim.cos, s: sim.sin } };
}

// ─── _sensorQueryCallback (b2SensorQueryCallback) ────────────────────────────

/**
 * Per-candidate narrow-phase callback for one sensor's AABB query.
 * Mirrors `b2SensorQueryCallback` (sensor.c:44-120).
 *
 * Rejection rules (in box2d order):
 *   1. shapeId == sensorShapeId           → skip self (sensor.c:54-57)
 *   2. otherShape.enableSensorEvents == false → skip (sensor.c:63-66)
 *   3. otherShape.bodyId == sensorShape.bodyId → skip same body (sensor.c:69-71)
 *   4. !b2ShouldShapesCollide(...)        → skip filter mismatch (sensor.c:75-77)
 *   5. Custom filter: not in scope for v1 (sensor.c:81-93 skipped)
 *   6. b2ShapeDistance overlap check: overlap when distance < 10 * FLT_EPSILON
 *      (sensor.c:98-110)
 *
 * On overlap: push a VisitorRecord to sensor.overlaps2 (sensor.c:113-118).
 */
function sensorQueryCallback(
  shapeIndex: number,
  sensorShapeIndex: number,
  sensorShape: InternalShape,
  sensorXf: Transform,
  sensor: SensorRecord,
  state: PhysicsState
): void {
  // 1. Skip self (b2SensorQueryCallback sensor.c:54-57):
  //    if (shapeId == sensorShapeId) return true;
  if (shapeIndex === sensorShapeIndex) {
    return;
  }

  const otherShape = state.shapes.records[shapeIndex];
  if (otherShape === undefined) {
    return;
  }

  // 2. Are sensor events enabled on the other shape?
  //    if (otherShape->enableSensorEvents == false) return true; (sensor.c:63-66)
  if (!otherShape.enableSensorEvents) {
    return;
  }

  // 3. Skip shapes on the same body (sensor.c:69-71):
  //    if (otherShape->bodyId == sensorShape->bodyId) return true;
  if (otherShape.bodyHandle.index === sensorShape.bodyHandle.index) {
    return;
  }

  // 4. Collision filter (sensor.c:75-77):
  //    if (b2ShouldShapesCollide(sensorShape->filter, otherShape->filter) == false) return true;
  if (!shouldShapesCollide(sensorShape, otherShape)) {
    return;
  }

  // 5. Custom filter: not in scope for v1 (sensor.c:81-93 skipped).

  // 6. Narrow overlap check via b2ShapeDistance (sensor.c:96-110):
  //    bool overlaps = output.distance < 10.0f * FLT_EPSILON;
  const otherXf = getBodyTransformForShape(state, otherShape);

  // Compose each shape's world transform = body transform ∘ shape local pose.
  // Mirrors b2GetBodyTransform (used for sensorShape in b2SensorTask) and the
  // indirect transform usage in b2SensorQueryCallback for otherShape.
  const sensorLocalXf: Transform = {
    p: { x: sensorShape.localX, y: sensorShape.localY },
    q: { c: sensorShape.localCos, s: sensorShape.localSin },
  };
  const otherLocalXf: Transform = {
    p: { x: otherShape.localX, y: otherShape.localY },
    q: { c: otherShape.localCos, s: otherShape.localSin },
  };
  const sensorWorldXf = mulTransforms(sensorXf, sensorLocalXf);
  const otherWorldXf = mulTransforms(otherXf, otherLocalXf);

  const input: DistanceInput = {
    proxyA: makeShapeDistanceProxy(sensorShape),
    proxyB: makeShapeDistanceProxy(otherShape),
    transformA: sensorWorldXf,
    transformB: otherWorldXf,
    useRadii: true,
  };
  const cache = emptySimplexCache();
  const output = shapeDistance(input, cache);

  // box2d sensor.c:107: bool overlaps = output.distance < 10.0f * FLT_EPSILON;
  // FLT_EPSILON ≈ 1.19e-7, so 10 * FLT_EPSILON ≈ 1.19e-6.
  const FLT_EPSILON = 1.1920929e-7;
  const overlaps = output.distance < 10.0 * FLT_EPSILON;
  if (!overlaps) {
    return;
  }

  // Record the overlap (sensor.c:113-118):
  //   b2Visitor* shapeRef = b2Array_Emplace(sensor->overlaps2);
  //   shapeRef->shapeId = shapeId;
  //   shapeRef->generation = otherShape->generation;
  sensor.overlaps2.push({
    shapeIndex,
    generation: state.shapes.idPool.generationOf(shapeIndex),
  });
}

// ─── _processSensorTask (b2SensorTask, per-sensor) ───────────────────────────

/**
 * Run the per-sensor overlap task. Mirrors `b2SensorTask` (sensor.c:135-237),
 * collapsed to single-threaded. The bitset logic (tracking which sensors
 * changed) is replaced by a direct boolean return.
 *
 * Steps:
 *   1. Swap overlaps1 ↔ overlaps2 (double-buffer swap).
 *   2. Append hits (CCD, always empty in v1) to overlaps2, then clear hits.
 *   3. Early-exit when body is disabled OR enableSensorEvents is false
 *      (emit changed=true so end events fire if overlaps1 was non-empty).
 *   4. Query all three broad-phase trees with the sensor AABB.
 *   5. Sort overlaps2 by shapeIndex (deterministic order, b2CompareVisitors).
 *   6. Dedup overlaps2 (same shapeIndex, keep first occurrence = latest gen).
 *   7. Return whether anything changed (count or visitor identity differs).
 */
function processSensorTask(
  sensor: SensorRecord,
  sensorShapeIndex: number,
  sensorShape: InternalShape,
  state: PhysicsState
): boolean {
  // 1. Swap overlap arrays (sensor.c:151-154):
  //    b2Array(b2Visitor) temp = sensor->overlaps1;
  //    sensor->overlaps1 = sensor->overlaps2;
  //    sensor->overlaps2 = temp;
  //    b2Array_Clear(sensor->overlaps2);
  const temp = sensor.overlaps1;
  sensor.overlaps1 = sensor.overlaps2;
  sensor.overlaps2 = temp;
  sensor.overlaps2.length = 0;

  // 2. Append hits to overlaps2, then clear (sensor.c:157-164).
  //    CCD is M5 — sensor.hits is always empty in v1.
  for (const hit of sensor.hits) {
    sensor.overlaps2.push(hit);
  }
  sensor.hits.length = 0;

  // 3. Early-exit: body disabled OR enableSensorEvents == false (sensor.c:167-175):
  //    if (body->setIndex == b2_disabledSet || sensorShape->enableSensorEvents == false)
  const bodyRec = state.bodies.records[sensorShape.bodyHandle.index];
  const isDisabled =
    bodyRec === undefined || bodyRec.setIndex === DISABLED_SET || !sensorShape.enableSensorEvents;

  if (isDisabled) {
    // Something changed if there were overlaps to drop (sensor.c:168-174):
    //   if (sensor->overlaps1.count != 0) b2SetBit(&taskContext->eventBits, sensorIndex);
    return sensor.overlaps1.length !== 0;
  }

  // 4. Build sensor body transform + sensor AABB, then query all three trees.
  //    Mirrors sensor.c:177-193:
  //      b2Transform transform = b2GetBodyTransformQuick(world, body);
  //      b2AABB queryBounds = sensorShape->aabb;
  //      b2DynamicTree_Query(trees + 0, queryBounds, ...);
  //      b2DynamicTree_Query(trees + 1, queryBounds, ...);
  //      b2DynamicTree_Query(trees + 2, queryBounds, ...);
  const bodySim = state.solverSets[bodyRec.setIndex]!.bodySims[bodyRec.localIndex]!;
  const sensorBodyXf: Transform = {
    p: { x: bodySim.transformX, y: bodySim.transformY },
    q: { c: bodySim.cos, s: bodySim.sin },
  };

  // Use the sensor shape's tight AABB (world space) as the query bounds.
  const queryBounds: AABB = {
    lowerBound: { x: sensorShape.aabbMinX, y: sensorShape.aabbMinY },
    upperBound: { x: sensorShape.aabbMaxX, y: sensorShape.aabbMaxY },
  };

  // Query all three trees (static, kinematic, dynamic).
  state.broadPhase.queryAll(queryBounds, sensorShape.maskBits, (_proxyId, shapeIndex) => {
    sensorQueryCallback(shapeIndex, sensorShapeIndex, sensorShape, sensorBodyXf, sensor, state);
    return true; // continue
  });

  // 5. Sort overlaps2 by shapeIndex (sensor.c:196):
  //    qsort(sensor->overlaps2.data, ..., b2CompareVisitors);
  sensor.overlaps2.sort((a, b) => a.shapeIndex - b.shapeIndex);

  // 6. Dedup overlaps2 — same shapeIndex, keep first (sensor.c:199-210):
  //    int uniqueCount = 0;
  //    for (int i = 0; i < overlapCount; ++i) {
  //      if (uniqueCount == 0 || overlapData[i].shapeId != overlapData[uniqueCount-1].shapeId)
  //        overlapData[uniqueCount++] = overlapData[i];
  //    }
  let uniqueCount = 0;
  for (let i = 0; i < sensor.overlaps2.length; i++) {
    const v = sensor.overlaps2[i]!;
    if (uniqueCount === 0 || v.shapeIndex !== sensor.overlaps2[uniqueCount - 1]!.shapeIndex) {
      sensor.overlaps2[uniqueCount] = v;
      uniqueCount++;
    }
  }
  sensor.overlaps2.length = uniqueCount;

  // 7. Check whether anything changed (sensor.c:212-233):
  //    if (count1 != count2) b2SetBit(...); else for each pair compare...
  const count1 = sensor.overlaps1.length;
  const count2 = sensor.overlaps2.length;
  if (count1 !== count2) {
    return true;
  }
  for (let i = 0; i < count1; i++) {
    const r1 = sensor.overlaps1[i]!;
    const r2 = sensor.overlaps2[i]!;
    if (r1.shapeIndex !== r2.shapeIndex || r1.generation !== r2.generation) {
      return true;
    }
  }
  return false;
}

// ─── overlapSensors (b2OverlapSensors) ───────────────────────────────────────

/**
 * Run the full sensor overlap pass for one step.
 *
 * Mirrors `b2OverlapSensors` (sensor.c:239-370), collapsed to a single serial
 * pass (no bitsets, no worker-thread union).
 *
 * For each sensor that changed:
 *   - overlaps in overlaps2 not in overlaps1 (or newer generation) → begin event
 *   - overlaps in overlaps1 not in overlaps2 (or older generation) → end event
 *   - same shapeIndex + same generation → persisted (no event)
 *
 * Events are appended to `state.sensorBeginEvents` / `state.sensorEndEvents`.
 * These arrays are cleared at the top of `engineStep` so they hold only the
 * current step's events (consistent with contactBeginEvents / contactEndEvents).
 * VP-21b (`PhysicsEvents`) consumes them.
 *
 * The two-finger sorted merge is verbatim from sensor.c:292-366.
 */
export function overlapSensors(state: PhysicsState): void {
  const sensors = state.sensors;
  const count = sensors.count;
  if (count === 0) {
    return;
  }

  // Run per-sensor task and collect indices of sensors that changed.
  // Mirrors the bitset collection in b2OverlapSensors (sensor.c:250-265) but
  // as a plain array of changed sensor indices.
  const changed: number[] = [];
  for (let si = 0; si < count; si++) {
    const sensor = sensors.records[si]!;
    const shape = state.shapes.records[sensor.shapeIndex];
    if (shape === undefined) {
      continue;
    }

    const didChange = processSensorTask(sensor, sensor.shapeIndex, shape, state);
    if (didChange) {
      changed.push(si);
    }
  }

  // Process changed sensors: two-finger sorted merge of overlaps1 vs overlaps2.
  // Mirrors sensor.c:268-366.
  for (const si of changed) {
    const sensor = sensors.records[si]!;
    const sensorShape = state.shapes.records[sensor.shapeIndex];
    if (sensorShape === undefined) {
      continue;
    }

    // Build the sensor's handle for the event payload.
    // Mirrors sensor.c:283:
    //   b2ShapeId sensorId = { sensor->shapeId + 1, world->worldId, sensorShape->generation };
    const sensorHandle: Handle = {
      index: sensor.shapeIndex,
      generation: state.shapes.idPool.generationOf(sensor.shapeIndex),
    };

    const refs1 = sensor.overlaps1;
    const refs2 = sensor.overlaps2;
    const count1 = refs1.length;
    const count2 = refs2.length;

    // Two-finger merge (sensor.c:292-341):
    let index1 = 0;
    let index2 = 0;
    while (index1 < count1 && index2 < count2) {
      const r1 = refs1[index1]!;
      const r2 = refs2[index2]!;
      if (r1.shapeIndex === r2.shapeIndex) {
        if (r1.generation < r2.generation) {
          // end then begin for the same shapeIndex (sensor replaced)
          // sensor.c:299-309:
          //   if (r1->generation < r2->generation) { // end
          //     b2Array_Push(world->sensorEndEvents[...], event); index1++;
          state.sensorEndEvents.push({
            sensorShape: sensorHandle,
            visitorShape: { index: r1.shapeIndex, generation: r1.generation },
          });
          index1++;
        } else if (r1.generation > r2.generation) {
          // begin (sensor.c:310-319):
          //   else if (r1->generation > r2->generation) { // begin
          //     b2Array_Push(world->sensorBeginEvents, event); index2++;
          state.sensorBeginEvents.push({
            sensorShape: sensorHandle,
            visitorShape: { index: r2.shapeIndex, generation: r2.generation },
          });
          index2++;
        } else {
          // persisted (sensor.c:320-324): index1++; index2++;
          index1++;
          index2++;
        }
      } else if (r1.shapeIndex < r2.shapeIndex) {
        // end (sensor.c:325-330):
        //   b2Array_Push(world->sensorEndEvents[...], event); index1++;
        state.sensorEndEvents.push({
          sensorShape: sensorHandle,
          visitorShape: { index: r1.shapeIndex, generation: r1.generation },
        });
        index1++;
      } else {
        // begin (sensor.c:331-337):
        //   b2Array_Push(world->sensorBeginEvents, event); index2++;
        state.sensorBeginEvents.push({
          sensorShape: sensorHandle,
          visitorShape: { index: r2.shapeIndex, generation: r2.generation },
        });
        index2++;
      }
    }

    // Drain remaining overlaps1 → end events (sensor.c:343-351):
    while (index1 < count1) {
      const r1 = refs1[index1]!;
      state.sensorEndEvents.push({
        sensorShape: sensorHandle,
        visitorShape: { index: r1.shapeIndex, generation: r1.generation },
      });
      index1++;
    }

    // Drain remaining overlaps2 → begin events (sensor.c:353-361):
    while (index2 < count2) {
      const r2 = refs2[index2]!;
      state.sensorBeginEvents.push({
        sensorShape: sensorHandle,
        visitorShape: { index: r2.shapeIndex, generation: r2.generation },
      });
      index2++;
    }
  }
}

// ─── destroySensor (b2DestroySensor) ─────────────────────────────────────────

/**
 * Emit end events for all current overlaps and remove the sensor record.
 * Called by `shape_lifecycle.ts` before freeing a sensor shape.
 *
 * Mirrors `b2DestroySensor` (sensor.c:372-409):
 *   1. For each visitor in overlaps2 → push a SensorEndTouchEvent.
 *   2. b2Array_RemoveSwap(world->sensors, sensorShape->sensorIndex).
 *   3. If a sensor moved: fix its shape's sensorIndex.
 *
 * The caller is responsible for zeroing `shape.sensorIndex` after this returns.
 */
export function destroySensor(state: PhysicsState, sensorIndex: number): void {
  const sensor = state.sensors.records[sensorIndex];
  if (sensor === undefined) {
    return;
  }

  // 1. Emit end events for current overlaps (sensor.c:375-393):
  //    for (int i = 0; i < sensor->overlaps2.count; ++i) {
  //      b2Array_Push(world->sensorEndEvents[...], event); }
  const sensorHandle: Handle = {
    index: sensor.shapeIndex,
    generation: state.shapes.idPool.generationOf(sensor.shapeIndex),
  };
  for (const ref of sensor.overlaps2) {
    state.sensorEndEvents.push({
      sensorShape: sensorHandle,
      visitorShape: { index: ref.shapeIndex, generation: ref.generation },
    });
  }

  // 2 & 3. Swap-remove (sensor.c:401-408):
  //   int movedIndex = b2Array_RemoveSwap(world->sensors, sensorShape->sensorIndex);
  //   if (movedIndex != B2_NULL_INDEX) {
  //     b2Shape* otherSensorShape = b2Array_Get(world->shapes, movedSensor->shapeId);
  //     otherSensorShape->sensorIndex = sensorShape->sensorIndex;
  //   }
  const movedShapeIndex = state.sensors.destroy(sensorIndex);
  if (movedShapeIndex !== -1) {
    // Fix the moved sensor's shape's sensorIndex pointer.
    const movedShape = state.shapes.records[movedShapeIndex];
    if (movedShape !== undefined) {
      movedShape.sensorIndex = sensorIndex;
    }
  }
}
