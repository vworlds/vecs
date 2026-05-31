# Solver, CCD, And Sleep Implementation Map

This file is the maintainer-facing map for the solver/CCD/sleep subsystem. It
answers where the code lives and why the port made the choices it did. It is not
a replacement for `PLAN.md`: the plan records design intent; this file maps the
implemented files, functions, and verified Box2D source anchors.

The v1 solver is a Box2D v3-style TGS soft-step solver over one overflow
constraint color. It prepares contact constraints once, then sub-steps velocity
integration, warm start, biased contact solve, position integration, and relax;
after the sub-steps it applies restitution and stores impulses back to the
manifold. Sleep, CCD, hit events, sensor overlap, broad-phase refit, and
pose/write-back orchestration sit around that core loop in `engine/step.ts`.

V1 deliberately does not port constraint graph coloring, joints, multi-threaded
task scheduling, contact recycling, custom contact filters, ray/shape casts,
AABB queries, or the sensor TOI hit queue.

Cross-links: `PROGRESS.md` section VP-17, VP-18, VP-23, VP-24, VP-26; `PLAN.md`
section `Settled Decisions` bullets for solver flavour, contact storage,
broad-phase `pairSet`, fat-AABB hysteresis, sleep, CCD, id generations, and
solver-set transfers.

## Step Orchestration: `engine/step.ts`

`engineStep(state, dt, subSteps)` owns the per-step flow:

- Clear `bodyMoveEvents`, `bulletBodies`, `fellAsleepThisStep`, and split-island
  bookkeeping.
- Install sleep hooks so island/contact code can wake solver sets without a
  circular import.
- Apply pending impulses before collide/solve so the solver sees the velocity
  delta in the same step.
- Build `StepContext` with `makeStepContext`.
- Run `broadPhase.updatePairs(makePairCreateCallback(state))` to create new
  contacts.
- Run `collide(state, ctx)` for narrow-phase refresh and contact state changes.
- Run `solve(state, ctx)` for the eight-stage TGS solver.
- Run `gatherHitEvents(state)` after impulses have been stored and before body
  transforms advance.
- Run `finalizeBodies(state, ctx, dt)` to fold delta poses into body transforms,
  clear forces, emit move events, accumulate sleep time, detect fast/bullet CCD,
  propagate `IS_SPEED_CAPPED` / `HAD_TIME_OF_IMPACT`, and refit shape proxies.
- Split the chosen island, then reverse-iterate awake islands through
  `trySleepIsland`.
- Run the bullet CCD stage with `solveContinuous` and `enlargeBulletProxies`.
- Run `overlapSensors(state)` after shape AABBs are current.

`finalizeBodies` is where the M5 sleep and CCD branches meet. The sleep block
computes the farthest-point sleep velocity, bumps `body.sleepTime`, populates the
awake-island set, and picks one split candidate. The CCD branch marks fast
bodies, resolves non-bullet fast bodies inline against the static tree, and
queues bullet bodies for the post-solve pass. Slow bodies use
`refitBodyShapeProxies(..., "enlarge")`, which now holds fat AABBs until the new
tight AABB escapes.

Cross-links: `PROGRESS.md` section VP-18, VP-23, VP-24, VP-26; `PLAN.md`
section `Settled Decisions` bullets for solver sub-step size, sleep,
continuous collision detection, and fat-AABB hysteresis.

## TGS Solver Core: `engine/solver.ts`

`makeStepContext` mirrors Box2D step-context setup: `h = dt / subSteps`,
`invH = subSteps / dt`, contact hertz clamping, and separate contact/static
softness. `makeSoft` is the direct `b2MakeSoft` port, including the `hertz === 0`
early return.

`ContactConstraint` and `ContactConstraintPoint` are scratch records built for
one `solve()` call. They mirror Box2D's contact constraint scratch shape, but
the storage is idiomatic JS objects reused across sub-steps instead of C arrays.
Static or null bodies resolve to a module-level identity body state; writes back
to body state happen only when `DYNAMIC_FLAG` is present.

`solve(state, ctx)` runs the v1 overflow-only stage order:

- `prepareContacts`: builds constraints from `state.graphContactSims`, copies
  mixed material values, chooses static vs dynamic softness, computes contact
  effective masses, captures warm-start impulses, and stores restitution input
  velocities.
- `integrateVelocities`: applies force, torque, gravity, and Pade damping to
  awake states.
- `warmStartContacts`: reapplies cached normal, tangent, and rolling impulses.
- `solveContacts(..., true)`: solves non-penetration with speculative/soft bias
  and the `-contactSpeed` clamp.
- `integratePositions`: applies motion locks and speed caps, then advances the
  solver delta pose.
- `solveContacts(..., false)`: relaxes without bias and applies friction plus
  rolling resistance.
- `applyRestitution`: applies bounce only when stored relative velocity and total
  normal impulse prove an actual collision.
- `storeImpulses`: writes normal/tangent/rolling impulses, total normal impulse,
  and normal velocity back onto manifold points for warm-starting and hit events.

`gatherHitEvents` scans touching contact sims after `storeImpulses`; it emits
events for contact points whose normal speed exceeds the configured threshold and
whose shapes opted into hit events.

Cross-links: `PROGRESS.md` section VP-17 and VP-22; `PLAN.md` section `Settled
Decisions` bullets for solver flavour and contact storage.

## Collide And Contact State: `engine/collide.ts`

`makePairCreateCallback` filters broad-phase candidate pairs by same-body,
sensor, and collision-filter rules, then calls `createContact`. The broad phase
does not own shape filtering in v1; it only emits raw overlap candidates that do
not already have a `pairSet` contact.

`collide(state, ctx)` gathers touching sims from `state.graphContactSims` and
non-touching sims from the awake set, refreshes per-contact body sim indices and
inverse masses, computes body transforms and CoM offsets, runs `updateContact`,
and records started/stopped/disjoint transitions by contact id.

The state-change loop sorts changed ids ascending before applying them. That is a
post-M3 parity fix: Box2D iterates a contact-id bitset in ascending id order, and
graph/awake swap moves can otherwise produce a different `graphContactSims`
order. Newly touching contacts are linked into islands first, then moved into the
graph. Newly non-touching contacts are unlinked, moved back to awake-set
`contactSims`, then removed from the graph.

Cross-links: `PROGRESS.md` section VP-18 and `M3-contact-state-change-order`;
`PLAN.md` section `Settled Decisions` bullets for broad-phase `pairSet`
ownership and contact storage.

## Contact Model: `engine/contact.ts`

`InternalContact` is the cold sparse record: body edges, set/color/local indices,
island indices, canonical shape ids, and flags. `ContactSim` is the hot dense
record used by collide and solve: manifold, mixed material values, transient body
indices, inverse masses, flags, and the GJK cache.

`createContact` ports the bookkeeping half of `b2CreateContact`: check whether a
narrow-phase pair exists, canonicalize shape order, choose awake vs disabled set,
allocate the cold record, link both body edge lists, add the pair key to
`BroadPhase`, and push a non-touching `ContactSim` into the owning set.

`destroyContact` removes the pair key, emits any end-touch event, unlinks both
body edge lists, unlinks from the island if needed, removes the sim from either
`state.graphContactSims` or a solver set, frees the id, and wakes bodies on
touching teardown when requested.

`updateContact` runs the narrow-phase manifold refresh, updates material values,
sets hit-event flags, shifts anchors to center-of-mass-relative coordinates, and
carries warm-start impulses by matching manifold point ids. It deliberately omits
pre-solve callbacks, custom filters, and speculative toggle handling.

`addContactToGraph` and `removeContactFromGraph` are the single-overflow-color
versions of Box2D's graph movement. Touching contacts live in
`state.graphContactSims`; non-touching contacts live in solver-set `contactSims`.

Cross-links: `PROGRESS.md` section VP-15, VP-18, and M3 review; `PLAN.md`
section `Settled Decisions` bullets for contact storage, no graph coloring, and
broad-phase `pairSet` ownership.

## Islands And Sleep: `engine/island.ts`, `engine/sleep.ts`

`engine/island.ts` builds the connectivity graph that sleep needs. It does not
drive solver iteration in v1: the solver reads the overflow contact array
directly. `createIsland`, `destroyIsland`, `mergeIslands`, `addContactToIsland`,
`linkContact`, `unlinkContact`, `createIslandForBody`, and
`removeBodyFromIsland` mirror Box2D island bookkeeping with all joint loops
removed.

`linkContact` has the M5 parity fix for sleeping sets: when one body is awake and
the other is sleeping it wakes the sleeping set; when both bodies are sleeping it
does not merge their solver sets. Box2D's merge helper is joint-driven, not
contact-driven, and v1 has no joints.

`splitIsland` is the M5 union-find split. It snapshots the base island, unions
connected non-static bodies through touching contacts, creates one new island per
component, reassigns bodies and contacts, drops joint handling, and destroys the
base island.

`engine/sleep.ts` owns sleeping solver sets:

- `allocSleepingSet` / `freeSleepingSet` manage solver-set indices at and above
  `FIRST_SLEEPING_SET`.
- `wakeSolverSet` moves body sims to the awake set, restores identity body
  states, moves non-touching disabled contacts back to awake, moves touching
  contacts back into the graph, transfers island sims, and frees the sleeping
  set.
- `trySleepIsland` allocates a sleeping set, moves body sims out of awake, marks
  move events as fell asleep, moves non-touching contacts to disabled, moves
  touching contacts out of the graph into the sleeping set, and transfers the
  island sim.
- `mergeSolverSets` remains wired for future joint support but is currently
  unused by contact linking.
- `wakeBody` is the body-level adapter used by force, impulse, teleport, and
  kinematic wake paths.

Cross-links: `PROGRESS.md` section VP-16 and VP-23; `PLAN.md` section `Settled
Decisions` bullets for sleep, `linkContact` sleeping-set behaviour, no joints,
and solver-set transfers.

## Continuous Collision: `engine/ccd.ts`, `engine/distance.ts`

`engine/ccd.ts` ports the single-threaded fast/bullet CCD path. The fast/bullet
detection branch lives in `finalizeBodies`: non-bullet fast bodies call
`solveContinuous` inline and query only the static tree; bullet bodies are queued
and later query static, kinematic, and dynamic trees. Other bullet bodies are
skipped, matching Box2D.

`_continuousQueryCallback` applies the rejection rules: same shape, same body,
sensors, collision filter, other bullet, no-joint body filtering, and no custom
filter callbacks. It has the chain-segment parallel-motion early-out, then runs
`timeOfImpact`; zero-fraction TOI falls back to a small circle around the fast
shape centroid. Sensor TOI hits are intentionally not queued in v1.

`solveContinuous` sweeps every non-sensor shape on the fast body, records the
earliest solid hit fraction, advances the body to the TOI fraction, refits its
shape AABBs, and marks fat-AABB/proxy enlargement when needed. If there is no
solid hit, it advances the sweep baseline and still checks whether the already
computed end-of-step AABB escaped the fat AABB.

`enlargeBulletProxies` is the post-bullet broad-phase update. It clears
`ENLARGE_BOUNDS`, walks marked bullet shapes, clears `enlargedAABB`, and enlarges
their dynamic-tree proxies.

`engine/distance.ts` supplies the geometry CCD needs: `segmentDistance`, GJK
`shapeDistance`, sweep helpers, separation-function helpers, and `timeOfImpact`
using conservative advancement.

Cross-links: `PROGRESS.md` section VP-24; `PLAN.md` section `Settled Decisions`
bullet for continuous collision detection and the v1 non-goals for casts/queries.

## Broad Phase, Dynamic Tree, And Fat AABBs

`engine/broad_phase.ts` wraps three `DynamicTree`s, one for each numeric body
type. Proxy keys pack `(proxyId << 2) | bodyType`. Pair keys are canonicalized
shape-index pairs stored in a JS `Set<number>`.

`BroadPhase.updatePairs` walks the move buffer, queries the appropriate trees,
deduplicates moving/moving candidates, skips pairs already in `_pairSet`, and
emits raw candidate pairs. It does not filter by shape and does not add to
`_pairSet`; `createContact` owns the add and `destroyContact` owns the remove.

`queryAll` supports sensor overlap. `queryTree` supports CCD by querying exactly
one body-type tree. `createProxy` has a `forcePairCreation` path for static
proxies so newly created static shapes can emit overlaps immediately.

`engine/dynamic_tree.ts` is the BVH: node pool, create/destroy/move/enlarge
proxy, insert/remove leaf, balancing rotations, query, ray cast, rebuild, and
validation.

`engine/shape.ts` owns AABB update and refit. `updateShapeAABBs` resets both
tight and fat AABBs for creation and teleports. `refitBodyShapeProxies` in
`"enlarge"` mode implements the M5 fat-AABB hysteresis fix: only the tight AABB
is updated while it remains inside the existing fat AABB; on escape the fat AABB
is reset and the proxy is enlarged.

Cross-links: `PROGRESS.md` section VP-18, M3 review fat-AABB finding, and VP-26;
`PLAN.md` section `Settled Decisions` bullets for broad-phase `pairSet`,
fat-AABB hysteresis, and sensors as a separate pass.

## Mass And Extents: `engine/mass.ts`

`updateBodyMassData` recomputes body mass, inverse inertia, local center,
world-space center, and min/max extents from attached shapes. Static and
kinematic bodies keep zero mass; kinematic bodies still compute extents for
sleep/CCD.

Dynamic bodies accumulate only non-zero-density shapes. Sensors contribute to
mass exactly like solid shapes when their density is non-zero; Box2D skips only
`density == 0`. A massless dynamic body keeps `invMass = 0` rather than receiving
a default unit mass.

The one intentional carry is CoM-shift velocity adjustment: Box2D updates awake
linear velocity when the center of mass moves, but v1 does not thread a
`BodyState` into mass recomputation. M5 assessed this as safe for v1 and deferred
it to v2 or a targeted regression.

Cross-links: `PROGRESS.md` section VP-12 and VP-23 carried-forward assessment;
`PLAN.md` section `Settled Decisions` bullets for sensor mass and massless
dynamic bodies.

## Box2D Source Map

Only references verified against `lib/vecs-physics/box2d/` at commit
`6e96697064e1ec09265c64fe953e5e056098c215` are included.

| vecs-physics code                    | Box2D source                                         | Notes                                                                       |
| ------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `solver.ts makeSoft`                 | `solver.h:239-260`                                   | Softness coefficients and `hertz == 0` branch.                              |
| `solver.ts StepContext`              | `physics_world.c:876-904`, `solver.h:154-213`        | Time step, softness, restitution, warm-start setup.                         |
| `solver.ts prepareContacts`          | `contact_solver.c:24-160`                            | Overflow contact constraint preparation.                                    |
| `solver.ts integrateVelocities`      | `solver.c:65-111`                                    | Force/gravity/damping velocity integration.                                 |
| `solver.ts warmStartContacts`        | `contact_solver.c:162-237`                           | Cached normal/tangent/rolling impulse application.                          |
| `solver.ts solveContacts`            | `contact_solver.c:239-408`                           | Bias solve, relax solve, friction, rolling resistance.                      |
| `solver.ts integratePositions`       | `solver.c:113-149`                                   | Motion locks and speed caps; later lines continue delta-pose advance.       |
| `solver.ts applyRestitution`         | `contact_solver.c:410-514`                           | Restitution gated by relative velocity and normal impulse.                  |
| `solver.ts storeImpulses`            | `contact_solver.c:516-545`                           | Manifold impulse and normal-velocity write-back.                            |
| `solver.ts solve stage order`        | `solver.c:1038-1045`, `solver.c:1268-1319`           | Stage list and `b2Solve` setup.                                             |
| `step.ts engineStep`                 | `physics_world.c:817-936`                            | World step order: pairs, context, collide, solve, sensors.                  |
| `step.ts finalizeBodies`             | `solver.c:544-736`                                   | Finalize transforms, sleep accumulation, CCD detection, AABB refit.         |
| `step.ts sleep loop`                 | `solver.c:2003-2059`                                 | Reverse island sleep loop after solve/refit/bullets.                        |
| `step.ts bullet stage`               | `solver.c:1249-1265`, `solver.c:1896-1968`           | Bullet task and serial bullet proxy enlargement.                            |
| `collide.ts collide`                 | `physics_world.c:428-581`, `physics_world.c:610-815` | Contact refresh and serial state-change loop.                               |
| `collide.ts state-change order`      | `physics_world.c:697-704`                            | Ascending contact-id bitset iteration.                                      |
| `collide.ts non-touching moves`      | `physics_world.c:583-607`                            | Add/remove non-touching contact sims.                                       |
| `contact.ts createContact`           | `contact.c:224-373`                                  | Contact allocation, edge links, pair-set add, non-touching sim.             |
| `contact.ts destroyContact`          | `contact.c:382-510`                                  | Pair-set remove, edge unlink, sim removal, wake-on-destroy.                 |
| `contact.ts updateContact`           | `contact.c:527-707`                                  | Manifold refresh, warm-start id carry, hit flag, touching flag.             |
| `contact.ts add/remove graph`        | `constraint_graph.c:66-212`                          | Overflow graph movement and swap-remove repair.                             |
| `island.ts create/destroy/merge`     | `island.c:15-82`, `island.c:82-172`                  | Island allocation, free, and keep-bigger merge.                             |
| `island.ts link/unlink`              | `island.c:174-260`                                   | Contact link, sleeping-set wake checks, unlink count bump.                  |
| `island.ts splitIsland`              | `island.c:389-650`, `island.c:659-673`               | Union-find split and split task wrapper; joints omitted.                    |
| `sleep.ts wakeSolverSet`             | `solver_set.c:35-151`                                | Wake sleeping set back to awake set and graph.                              |
| `sleep.ts trySleepIsland`            | `solver_set.c:155-411`                               | Sleep allocation, body/contact/island transfers, and split-candidate reset. |
| `sleep.ts mergeSolverSets`           | `solver_set.c:417-508`                               | Sleeping-set merge; currently future joint support in v1.                   |
| `solver_set.ts transferBody`         | `solver_set.c:511-536`                               | Body transfer and transient flag clear.                                     |
| `ccd.ts continuous query`            | `solver.c:181-376`                                   | CCD query rejection, TOI, sensor-hit deferral point.                        |
| `ccd.ts solveContinuous`             | `solver.c:379-541`                                   | Sweep, tree queries, TOI advance, AABB update.                              |
| `ccd.ts fast/bullet detection`       | `solver.c:633-657`                                   | `IS_FAST`, bullet queue, non-bullet inline CCD.                             |
| `ccd.ts enlargeBulletProxies`        | `solver.c:1907-1958`                                 | Serial bullet shape proxy enlargement.                                      |
| `distance.ts timeOfImpact`           | `distance.c:1140-1426`                               | Conservative advancement TOI.                                               |
| `distance.ts separation helpers`     | `distance.c:935-1136`                                | Separation function, min separation, evaluate separation.                   |
| `distance.ts sweep helpers`          | `distance.c:14-30`, `body.h:235-244`                 | Sweep transform and body sweep construction.                                |
| `broad_phase.ts create/move/enlarge` | `broad_phase.c:104-147`                              | Proxy creation, static force-pair path, move/enlarge buffering.             |
| `broad_phase.ts pair callback model` | `broad_phase.c:171-279`                              | Moving-pair dedup, pair-set skip, shape filtering source.                   |
| `shape.ts refitBodyShapeProxies`     | `solver.c:703-728`                                   | Per-step fat-AABB hysteresis and proxy enlargement.                         |
| `mass.ts updateBodyMassData`         | `body.c:515-647`                                     | Mass accumulation, sensor mass parity, CoM-shift deferral.                  |

Cross-links: `PROGRESS.md` section M3 and M5 Box2D source maps; `PLAN.md`
section `Settled Decisions`.

## Intentional Deviations From Box2D

| Deviation                                                                      | vecs-physics location                               | Why / link                                                                                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Single overflow color, no constraint graph coloring.                           | `contact.ts`, `solver.ts`, `state.graphContactSims` | V1 serial JS path keeps Box2D overflow semantics without graph coloring. `PLAN.md` -> `Settled Decisions` -> contact storage.                                            |
| `pairSet` owned by the contact layer.                                          | `broad_phase.ts`, `contact.ts`                      | Pair membership means "contact exists"; broad phase emits raw candidates. `PLAN.md` -> `Settled Decisions` -> broad-phase `pairSet` ownership.                           |
| Solver-set transfers move object references, not bytes.                        | `solver_set.ts`, `sleep.ts`, `contact.ts`           | Same swap-pop/index model, idiomatic JS representation. `PLAN.md` -> `Settled Decisions` -> solver-set transfers.                                                        |
| `IdPool` owns generations.                                                     | `util/id_pool.ts`, storage classes                  | Validity is centralized in the allocator instead of object records. `PLAN.md` -> `Settled Decisions` -> internal id generations.                                         |
| Fat-AABB hysteresis fixed in M5.                                               | `shape.ts refitBodyShapeProxies`                    | M0-M3 recentered fat AABBs too eagerly; VP-26 now matches Box2D. `PLAN.md` -> `Settled Decisions` -> fat-AABB hysteresis.                                                |
| Sensors are not contacts.                                                      | `collide.ts`, `sensor.ts`, `step.ts`                | Solid contacts skip sensors; `overlapSensors` runs separately after finalize. `PLAN.md` -> `Settled Decisions` -> sensors separate pass.                                 |
| `linkContact` does not merge two sleeping sets.                                | `island.ts linkContact`                             | Box2D only wakes one sleeping set when the other body is awake; both sleeping remain distinct. `PLAN.md` -> `Settled Decisions` -> `linkContact` sleeping-set behaviour. |
| Impulse accumulation uses `onSet` hooks.                                       | `systems/impulse_accumulate.ts`, `step.ts`          | Vecs update inbox stores references, so hooks are the only correct per-set accumulator. `PLAN.md` -> `Settled Decisions` -> impulse accumulation.                        |
| CCD transient flags propagate from sim/state to body during transfer/finalize. | `body.ts`, `solver_set.ts`, `step.ts`               | `IS_SPEED_CAPPED` and `HAD_TIME_OF_IMPACT` are retained; `IS_FAST` is step-local. `PROGRESS.md` VP-24 review fix.                                                        |
| Joints are omitted everywhere.                                                 | `island.ts`, `sleep.ts`, `solver.ts`                | V1 has no joints; all joint arrays/tasks are non-goals. `PLAN.md` -> `Settled Decisions` / v1 non-goals.                                                                 |
| Sensor TOI hits queue is omitted.                                              | `ccd.ts`, `sensor.ts`                               | AABB sensor overlap covers v1; TOI-precise sensor hits are future scope. `PROGRESS.md` VP-24 and M5 carry-forward.                                                       |

Cross-links: `PROGRESS.md` section M3 review, VP-23, VP-24, VP-26; `PLAN.md`
section `Settled Decisions`.

## V1 Non-Goals

- Constraint graph coloring beyond the single overflow color.
- Joints and all joint island/solver/sleep paths.
- Multi-threaded task scheduling and worker-local bitsets.
- Contact recycling (`recycleDistance = 0` in v1).
- Custom contact filter callbacks and pre-solve callbacks.
- Ray casts, shape casts, and public AABB queries.
- Sensor TOI hits queue.
- A deep TGS theory explainer; open the Box2D source for derivations.

Cross-links: `CLOSING_PLAN.md` section VP-29; `PLAN.md` section `Settled
Decisions` and v1 non-goals; `PROGRESS.md` section M6 contract.
