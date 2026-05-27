# vecs monorepo

This repository contains the `@vworlds/vecs` TypeScript libraries.

## Packages

- `lib/vecs`: the `@vworlds/vecs` ECS core (world, entity, query, system, DSL, bitset).
- `lib/vecs-wire`: binary encoder/decoder and the `@type` field decorator.
- `lib/vecs-protocol`: wire protocol messages (`Server2Client`, `Client2Server`, `StateDiff`, `RPC`).
- `lib/vecs-server`: Node.js-oriented `VecsServer` / `VecsListener`.
- `lib/vecs-client`: browser-oriented `VecsClient` / `Interpolator`.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run test
npm run build
```
