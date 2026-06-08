# @vworlds/vecs-phaser-client

Browser runtime adapter: observes a replicated `ClientWorld` and automatically creates,
updates, and destroys Phaser GameObjects (`PhaserVecsRuntime`, `CoordSpace`). All pixel,
PPM, and Y-flip conversion lives here at the Phaser frontier.

Depends on `@vworlds/vecs-phaser` and `@vworlds/vecs-client`. Requires `phaser@^4.1.0` as
a peer dependency (provided by the application).
