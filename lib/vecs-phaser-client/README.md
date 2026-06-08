# @vworlds/vecs-phaser-client

> **Planning stub** — package not yet implemented. See
> [`../vecs-phaser/architecture/README.md`](../vecs-phaser/architecture/README.md)
> for the design and
> [`../vecs-phaser/architecture/TICKETS.md`](../vecs-phaser/architecture/TICKETS.md)
> for the build plan.

Browser runtime adapter: observes a replicated `ClientWorld` and creates/updates/destroys
Phaser GameObjects (`PhaserVecsRuntime`, `CoordSpace`). All pixel/PPM/Y-flip conversion
lives here, at the Phaser frontier.

Depends on `@vworlds/vecs-phaser` and `@vworlds/vecs-client`; `phaser@^4.1.0` is a peer dependency.
