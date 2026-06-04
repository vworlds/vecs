The `box2d/` (C reference) and `box2d3-wasm/` (WASM build source)
directories under `lib/vecs-physics/` are git-ignored. If you are working
in a fresh worktree and need to look up Box2D source nuances:

```
cd lib/vecs-physics
git clone https://github.com/erincatto/box2d
(cd box2d && git checkout 3a4f0da8374af61293a03021c9a0b3ebcfe67948)
git clone https://github.com/Birch-san/box2d3-wasm
```

These are read-only references — never edit them, never check them in.
