# @vworlds/vecs

A small TypeScript ECS (Entity Component System) library designed for real-time game and simulation applications.

## What it is

`@vworlds/vecs` provides a lightweight ECS core with:

- **World** — the main container; holds all entities, components, and systems
- **Component** — base class for typed data attached to entities
- **Entity** — an integer ID with associated components
- **System** — a pipeline stage that queries and processes entities
- **Bitset** — fast bitset used internally for component masks and tags

Components are defined as classes. Systems declare which components they need and are wired up automatically by the world.

## Install

```
yarn add @vworlds/vecs
```

## Usage

```typescript
import { World, Component, System } from "@vworlds/vecs";

class Position extends Component {
  x = 0;
  y = 0;
}

class Velocity extends Component {
  dx = 0;
  dy = 0;
}

class MoveSystem extends System {
  static deps = [Position, Velocity];

  update(dt: number) {
    for (const entity of this.query()) {
      const pos = entity.get(Position)!;
      const vel = entity.get(Velocity)!;
      pos.x += vel.dx * dt;
      pos.y += vel.dy * dt;
    }
  }
}

const world = new World();
world.registerSystem(MoveSystem);

const entity = world.createEntity();
entity.add(new Position());
entity.add(new Velocity()).dx = 1;

world.update(16);
```

## Build

```
yarn build
```

## Test

```
yarn test
```

## License

UNLICENSED
