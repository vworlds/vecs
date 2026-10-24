# Network world id layout

Learn how `NetworkWorld` reserves ids for components, modules, and entities.

## Layout

`NetworkWorld` builds three non-overlapping ranges, in order: component ids, module ids, then entity
ids. With the default `entityIdStart` of 1000 and `moduleIdCount` of 100, components receive ids
1–899, modules 900–999, and entity allocation begins at 1000.

Set `moduleIdCount` when an application needs more module ids. For example, 300 reserves ids 700–999
for modules and leaves component ids 1–699. The option must be a positive safe integer, and the
layout must leave at least one component id. `entityIdStart` remains the first entity id.

```ts
import { NetworkWorld } from "@vworlds/vecs-protocol";

const world = new NetworkWorld({ moduleIdCount: 300 });
```

`moduleIdCount` is construction-time and process-local. Module and component eids do not appear on
the wire: network component snapshots use their `wireType`, and replicated entities use entity ids
from `entityIdStart`. Therefore the server and its clients may choose different module counts.

See [Id pools](../../vecs/docs/components.md#id-pools) for the underlying pool behavior.

`networkComponents` rejects local schema metadata (`ComponentDef` and `Trait`). Keep
[definition and trait declarations](../../vecs/docs/components.md#reflecting-on-component-definitions)
local to each world rather than assigning them wire type ids.
