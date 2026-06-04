# vecs-physics benchmark baseline

Machine: Linux 6.17.0-23-generic x86_64 GNU/Linux; Node: v24.15.0.

Captured with `npm run bench` from `lib/vecs-physics/` on 2026-05-31.

```text
vecs-physics benchmark harness
==================================================
Running stacking (200 bodies x 500 steps)... done (117.3 ms)
Running falling_balls (100 circles x 300 steps)... done (104.6 ms)

scenario         | steps | total (ms) |  ms/step
-----------------+-------+------------+---------
stacking         |   500 |      117.3 |    0.235
falling_balls    |   300 |      104.6 |    0.349
```

This v1.0.0 baseline is informational only. `architecture/CLOSING_PLAN.md` section 5 decision 4 explicitly sets the v1 performance posture as a committed artifact with no regression gate; future regressions should land as ordinary `perf:` commits, and this file can be refreshed by re-running `npm run bench` on the target machine.
