# Measuring replication

Break down synchronous replication-frame costs without timing checks on the disabled connection path.

Enable [core system timing](../../vecs/docs/systems.md#measuring-systems) on a `ServerWorld`:

```ts
import { ServerWorld } from "@vworlds/vecs-server";

const world = new ServerWorld();
world.stats.enableSystems();
world.progress(1000, 16);
console.table(world.stats.operations());
world.stats.resetSystems();
world.stats.disableSystems();
```

`stats.operations()` returns snapshot rows `{ name, runs, totalMs, maxMs }` in first-seen order:

| Name                 | Measures                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `replication:encode` | The synchronous replication frame except socket sends: view reconciliation, snapshot capture/encoding, history and delta preparation, RPC framing, wire encoding and session housekeeping. |
| `replication:send`   | Synchronous `socket.send` calls, summed across connections, including close-linger traffic and throwing sends. Not promise settlement, delivery, or acknowledgements.                      |

Each row counts one run per `send()` frame, even when there are no clients or no outgoing packets;
send time is zero for such a frame. Normal `progress()` calls `send()` through the world's Send
system; direct `send()` and shutdown-driven frames also count. Disabling retains prior rows and
totals; a world that never enables timing has no operation rows. Reset clears both operation and
system totals without disabling measurement.

These rows **break down** the existing Send system's time; do not add them to the system table
when computing a tick total. Clock and aggregation overhead, and the Send system's subsequent
flush, can make its duration slightly larger than the sum of these rows. Replication components'
earlier recording systems appear separately in the system table.

`ServerWorld.send()` selects a plain or measuring socket-send primitive once per replication
frame and passes it through one shared replication body, including close-linger sends. Encoding
and transport-failure handling are shared too. The connection loop and plain primitive contain
no stats branch or extra clock reads. The instrumented frame wrapper reuses aggregate slots;
the underlying replication protocol can still allocate
frames and snapshots as before. Preparation time is the whole synchronous frame less measured
socket-send durations, not a pure encoder microbenchmark.
