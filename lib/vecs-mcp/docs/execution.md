# Execution semantics

Understand validation, visibility and partial failures before writing a batch.

Local-world mutations run synchronously **inline between ticks**, not in a
deferred scope. If `world.deferred` is true, the entire batch is rejected before
any op runs. The bridge never reaches into the command queue or schedules work
on the world. Reads are pull-only; there are no hooks, watches or per-tick tasks.

The whole batch is checked statically first: op shape, registered component and
relationship names, entity references, written-field schemas and read-only fields.
Validators run over the whole draft, including untouched fields; structural
constraints on untouched current values do not block unrelated writes.
An invalid op applies nothing, including preceding creates. Validation projects
explicit preceding writes and creates into an isolated draft; it does not run
hooks or attempt to predict cascades or relationship policies.

After validation, each op executes and routes immediately. Each op sees previous
ops, including merged field writes. Runtime failures (hooks, cleanup policies,
cascades, constructors) stop the batch. `applied` contains only completed ops,
and `error.index` is the zero-based failing op index. There is no rollback: the
failing op itself may already have changed state before a hook throws. A
mid-destroy throw is a programming error, not an atomic transaction failure;
the bridge reports it rather than trying to repair core state. Unattempted ops
are never queued for replay.

[Browser-client targets](./clients.md) use these same semantics on a macrotask
after `progress()`/`apply()` returns, not inside the deferred apply phase.

## Values and opacity

Component roots expose their enumerable data fields; nested values serialize
with a default depth limit of four. Entity values become `{ "$entity": eid }`.
Plain objects (including null-prototype objects) and arrays are traversed; any
other class instance becomes `{ "$opaque": "ConstructorName" }`, never walked.
At the depth limit a container becomes `{ "$opaque": "depth limit" }`; this
also bounds cycles. Non-finite numbers and undefined values serialize as null.

A component whose public `OnSnapshot` target is `DontSnapshot` is opaque as a
whole and cannot be added, removed, linked or set through MCP. Existing opaque
field values, including those inside an overwritten object or array, cannot be
overwritten. Relationship target storage is not exposed as a data field; use
the explicit targets/children lists and link/unlink operations instead.
