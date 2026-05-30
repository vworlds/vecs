# M4: Misleading `destroyContact` comment about SIM_STOPPED_TOUCHING path

**Severity:** Low (documentation only — no runtime impact).

## What is wrong

The JSDoc comment in `engine/contact.ts:406-409` describes the
`SIM_STOPPED_TOUCHING` path as emitting an end event "BEFORE calling
destroyContact":

> The SIM_STOPPED_TOUCHING path in collide.ts emits its own end event BEFORE
> calling destroyContact — but at that point the contact is no longer touching
> (CONTACT_TOUCHING_FLAG was cleared), so the guard below naturally does NOT
> double-emit.

The conclusion (no double-emit) is **correct**, but the description of HOW is
wrong: the `SIM_STOPPED_TOUCHING` path in `collide.ts:294-313` does **not** call
`destroyContact` at all — it calls `unlinkContact` and moves the contact to the
awake set as non-touching. The contact persists. Later, if the shapes move
apart, the contact reaches `SIM_DISJOINT` in a future step, at which point
`destroyContact` IS called — but `CONTACT_TOUCHING_FLAG` was already cleared
(line 296), so the guard skips the end-event. No double-emit, but through a
different mechanism than the comment describes.

## Why it is wrong

The phrase "BEFORE calling destroyContact" implies `destroyContact` is called
within the same path. It is not. The comment conflates "before a POSSIBLE FUTURE
destroyContact call" with "before calling destroyContact NOW". A future engineer
debugging this code could waste time looking for a `destroyContact` call that
does not exist in the `SIM_STOPPED_TOUCHING` branch.

## Impacted code

`lib/vecs-physics/src/engine/contact.ts:406-409`

## Impacted features

None — comment only. The double-emit prevention is correctly implemented (see
the `collide.ts` stopped-touching branch, which emits its own end event and
clears `CONTACT_TOUCHING_FLAG` before `destroyContact` could ever run).

## How to reproduce

1. Read `engine/contact.ts` lines 400-409.
2. Search `engine/collide.ts` for `SIM_STOPPED_TOUCHING` — there is no
   `destroyContact` call in that branch.
3. Confirm the actual mechanism: `SIM_STOPPED_TOUCHING` (collide.ts:294-313)
   emits the end event, clears `CONTACT_TOUCHING_FLAG`, calls `unlinkContact`,
   and moves the contact to the awake set non-touching array. The contact is NOT
   destroyed. If it later becomes `SIM_DISJOINT`, `destroyContact` runs — and
   the `(flags & CONTACT_TOUCHING_FLAG) !== 0` guard skips the end-event because
   the flag was already cleared.

## Possible fix

Rewrite lines 406-409 to:

> The SIM_STOPPED_TOUCHING path in collide.ts emits its own end event
> and clears CONTACT_TOUCHING_FLAG. If the contact later becomes SIM_DISJOINT
> and destroyContact is called, the CONTACT_TOUCHING_FLAG guard below
> naturally skips the end-event (no double-emit).
