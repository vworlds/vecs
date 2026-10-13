import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ChildOf,
  Delta,
  Entity,
  IntervalTickSource,
  Iter,
  Now,
  Relationship,
  World,
  type MaybeResolvedInjectTuple,
  type RequiredResolvedInjectTuple,
  type System,
} from "../src/index.js";

class Position {
  x = 0;
}
class Sprite {
  name = "sprite";
}
class Missing {
  missing = true;
}
class Link extends Relationship {}

function setup() {
  const world = new World();
  world.component(Position);
  world.component(Sprite);
  world.component(Missing);
  world.component(Link);
  return world;
}

describe("system clock injection", () => {
  for (const cadence of ["frame", "rate", "source", "interval"] as const) {
    for (const cursor of [Entity, Iter]) {
      for (const inject of [
        [Now, Delta, Position, Sprite],
        [Position, Now, Sprite, Delta],
        [Position, Sprite, Delta, Now],
      ] as const) {
        it(`${cadence}/${cursor.name}/${inject.indexOf(Now)}: all callback kinds use the processing tick`, () => {
          const world = setup();
          const records: Record<string, unknown[][]> = {
            enter: [],
            update: [],
            plain: [],
            each: [],
            exit: [],
          };
          const configure = (system: System<[typeof Position, typeof Sprite]>) => {
            if (cadence === "rate") {
              system.rate(2);
            }
            if (cadence === "source") {
              system.tickSource(new IntervalTickSource(0.02));
            }
            if (cadence === "interval") {
              system.interval(0.02);
            }
            return system;
          };
          const record = (kind: string, eOrIt: Entity | Iter, values: unknown[]) => {
            const entity = eOrIt instanceof Iter ? eOrIt.entity : eOrIt;
            const posIndex = inject.indexOf(Position);
            const spriteIndex = inject.indexOf(Sprite);
            records[kind].push([
              entity,
              values[inject.indexOf(Now)],
              values[inject.indexOf(Delta)],
              values[posIndex],
              values[spriteIndex],
            ]);
            if (eOrIt instanceof Iter) {
              expect(eOrIt.src[posIndex]).toBe(entity);
              expect(eOrIt.src[spriteIndex]).toBe(entity);
              expect(eOrIt.src[inject.indexOf(Now)]).toBeUndefined();
              expect(eOrIt.src[inject.indexOf(Delta)]).toBeUndefined();
            }
          };
          const system = configure(world.system("clock").with(Position, Sprite));
          // Both cursor overloads are checked separately below; this matrix exercises their shared runtime grammar.
          const options = { inject, cursor } as {
            inject: readonly [typeof Now, typeof Delta, typeof Position, typeof Sprite];
            cursor: typeof Iter;
          };
          system
            .enter(options, (e, values) => record("enter", e, values))
            .update({ ...options, watch: Position, onEnter: true }, (e, _p, values) =>
              record("update", e, values)
            )
            .each(options, (e, values) => record("each", e, values))
            .exit(options, (e, values) => record("exit", e, values));
          configure(world.system("plain").with(Position, Sprite)).update(
            { ...options, watch: Position },
            (e, _p, values) => record("plain", e, values)
          );
          const entity = world.entity().set(Position, { x: 42 }).add(Sprite);
          const pos = entity.get(Position)!;
          const sprite = entity.get(Sprite)!;
          if (cadence !== "frame") {
            world.progress(101, 7);
          }
          world.progress(205, cadence === "frame" ? 20 : 13);
          const first = [entity, 205, 20, pos, sprite];
          expect(records.enter).toEqual([first]);
          expect(records.update).toEqual([first]);
          expect(records.each).toEqual([first]);
          expect(records.plain).toEqual([]);

          entity.modified(Position);
          if (cadence !== "frame") {
            world.progress(301, 5);
          }
          world.progress(405, cadence === "frame" ? 22 : 17);
          const second = [entity, 405, 22, pos, sprite];
          expect(records.update).toEqual([first, second]);
          expect(records.plain).toEqual([second]);
          expect(records.each).toEqual([first, second]);

          entity.destroy();
          if (cadence !== "frame") {
            world.progress(501, 3);
            expect(records.exit).toEqual([]);
          }
          world.progress(605, cadence === "frame" ? 20 : 17);
          expect(records.exit).toEqual([[entity, 605, 20, pos, sprite]]);
          expect(pos.x).toBe(42);
        });
      }
    }
  }

  it("preserves retained enter and exit tuples and cursors between events", () => {
    const world = setup();
    const entered: [Iter, [number, Position, number]][] = [];
    const exited: [Iter, [number, Position, number]][] = [];
    world
      .system("retain")
      .with(Position)
      .enter({ cursor: Iter, inject: [Now, Position, Delta] }, (it, values) =>
        entered.push([it, values])
      )
      .exit({ cursor: Iter, inject: [Now, Position, Delta] }, (it, values) =>
        exited.push([it, values])
      );
    const first = world.entity().set(Position, { x: 1 });
    const firstPos = first.get(Position)!;
    world.progress(10, 2);
    first.destroy();
    const second = world.entity().set(Position, { x: 2 });
    const secondPos = second.get(Position)!;
    world.progress(30, 7);
    second.destroy();
    world.progress(50, 9);
    expect(entered.map(([, values]) => values)).toEqual([
      [10, firstPos, 2],
      [30, secondPos, 7],
    ]);
    expect(exited.map(([, values]) => values)).toEqual([
      [30, firstPos, 7],
      [50, secondPos, 9],
    ]);
    expect(entered[0][0].entity).toBe(first);
    expect(entered[1][0].entity).toBe(second);
    expect(entered[0][0]).not.toBe(entered[1][0]);
    expect(entered[0][1]).not.toBe(entered[1][1]);
  });

  it("mixes clocks with flattened targets, targets arrays and down fan-out", () => {
    const world = setup();
    const target = world.entity().set(Position, { x: 8 });
    const source = world.entity().set(Position, { x: 1 }).add(Link, target);
    const child1 = world.entity().add(ChildOf, source).add(Sprite);
    const child2 = world.entity().add(ChildOf, source);
    const calls: unknown[][] = [];
    world
      .system("fan")
      .with(Position, Link)
      .each(
        {
          cursor: Iter,
          inject: [
            Now,
            { target: [Link, [Entity, Position]] },
            Delta,
            { down: [ChildOf, [Sprite]] },
            Now,
            { targets: [Link, [Entity, Position]] },
            Delta,
          ],
        },
        (it, values) => {
          expectTypeOf(values).toEqualTypeOf<
            [
              number,
              Entity | undefined,
              Position | undefined,
              number,
              Sprite | undefined,
              number,
              ReadonlyArray<readonly [Entity, Position | undefined]>,
              number,
            ]
          >();
          calls.push([it.entity, [...values], [...it.src]]);
        }
      );
    world.progress(123, 19);
    const targetPos = target.get(Position);
    expect(calls).toEqual(
      [child1, child2].map((child) => [
        source,
        [123, target, targetPos, 19, child.get(Sprite), 123, [[target, targetPos]], 19],
        [undefined, target, target, undefined, child, undefined, [target], undefined],
      ])
    );
  });

  it("fills clocks at exit replay while target and targets values retain their snapshots", () => {
    const world = setup();
    const target = world.entity().set(Position, { x: 9 });
    const source = world.entity().add(Sprite).add(Link, target);
    const targetPos = target.get(Position)!;
    const calls: unknown[][] = [];
    world
      .system("snapshot")
      .with(Sprite)
      .rate(2)
      .exit(
        {
          cursor: Iter,
          inject: [
            Now,
            { target: [Link, [Entity, Position]] },
            Delta,
            { targets: [Link, Position] },
          ],
        },
        (it, values) => calls.push([it.entity, values, it.src])
      );
    world.progress(10, 10);
    world.progress(20, 10);
    source.destroy();
    target.destroy();
    world.progress(30, 10);
    expect(calls).toEqual([]);
    world.progress(40, 10);
    expect(calls).toEqual([
      [
        source,
        [40, target, targetPos, 20, [[targetPos]]],
        [undefined, target, target, undefined, [target]],
      ],
    ]);
  });

  it("combines processing clocks with entry snapshots and live update target projections", () => {
    const world = setup();
    const firstTarget = world.entity().set(Position, { x: 1 });
    const secondTarget = world.entity().set(Position, { x: 2 });
    const source = world.entity().add(Sprite).add(Link, firstTarget);
    const entered: unknown[][] = [];
    const updated: unknown[][] = [];
    const inject = [
      Delta,
      { target: [Link, [Entity, Position]] },
      Now,
      { targets: [Link, Position] },
    ] as const;
    world
      .system("projected-entry")
      .with(Sprite)
      .rate(2)
      .enter({ cursor: Iter, inject }, (it, values) => {
        expectTypeOf(values).toEqualTypeOf<
          [
            number,
            Entity | undefined,
            Position | undefined,
            number,
            ReadonlyArray<readonly [Position | undefined]>,
          ]
        >();
        entered.push([it.entity, values, it.src]);
      })
      .update({ cursor: Iter, watch: Sprite, inject, onEnter: true }, (it, _sprite, values) => {
        expectTypeOf(values).toEqualTypeOf<
          [
            number,
            Entity | undefined,
            Position | undefined,
            number,
            ReadonlyArray<readonly [Position | undefined]>,
          ]
        >();
        updated.push([it.entity, [...values], [...it.src]]);
      });
    world.progress(10, 8);
    source.remove(Link, firstTarget);
    source.add(Link, secondTarget);
    world.progress(20, 12);
    const expected = (target: Entity) => [
      source,
      [20, target, target.get(Position), 20, [[target.get(Position)]]],
      [undefined, target, target, undefined, [target]],
    ];
    expect(entered).toEqual([expected(firstTarget)]);
    expect(updated).toEqual([expected(secondTarget)]);
  });

  it("supports token-only each/update tuples without changing their reuse semantics", () => {
    const world = setup();
    const each: [number, number][] = [];
    const update: [number, number][] = [];
    world
      .system("numbers")
      .with(Position)
      .each([Now, Delta], (_e, values) => each.push(values))
      .update({ watch: Position, onEnter: true, inject: [Now, Delta] }, (_e, _p, values) =>
        update.push(values)
      );
    world.entity().add(Position);
    world.progress(10, 1);
    world.entity().add(Position);
    world.progress(20, 2);
    expect(each).toHaveLength(3);
    expect(each[0]).toBe(each[2]);
    expect(each[0]).toEqual([20, 2]);
    expect(update).toHaveLength(2);
    expect(update[0]).toBe(update[1]);
    expect(update[0]).toEqual([20, 2]);
  });

  it("types clocks as required numbers in each callback kind and mixed positions", () => {
    const world = setup();
    const system = world.system("types").with(Position);
    system
      .each([Now, Position, Delta, Missing], (_e, values) => {
        expectTypeOf(values).toEqualTypeOf<[number, Position, number, Missing | undefined]>();
      })
      .enter([Position, Delta, Now], (_e, values) => {
        expectTypeOf(values).toEqualTypeOf<[Position, number, number]>();
      })
      .exit({ cursor: Iter, inject: [Delta, Position, Now] }, (it, values) => {
        expectTypeOf(it).toEqualTypeOf<Iter>();
        expectTypeOf(values).toEqualTypeOf<[number, Position, number]>();
      })
      .update(
        { watch: Position, inject: [Missing, Now, Position, Delta], cursor: Iter },
        (it, pos, values) => {
          expectTypeOf(it).toEqualTypeOf<Iter>();
          expectTypeOf(pos).toEqualTypeOf<Position>();
          expectTypeOf(values).toEqualTypeOf<[Missing | undefined, number, Position, number]>();
        }
      );
    expectTypeOf<MaybeResolvedInjectTuple<readonly [typeof Now, typeof Delta], []>>().toEqualTypeOf<
      [number, number]
    >();
    expectTypeOf<RequiredResolvedInjectTuple<readonly [typeof Delta, typeof Now]>>().toEqualTypeOf<
      [number, number]
    >();
    const noWith = world.system("no-with");
    noWith.enter([Now, Delta], (_e, values) => {
      expectTypeOf(values).toEqualTypeOf<[number, number]>();
    });
  });

  it("rejects clocks on standalone queries at compile time and registration time", () => {
    const query = setup().query("standalone").with(Position);
    const message = /Now and Delta injection is only supported in system/;
    expect(() => {
      // @ts-expect-error Standalone entry has no system clock.
      query.enter([Now], () => {});
    }).toThrow(message);
    expect(() => {
      // @ts-expect-error Standalone exit has no system clock, including cursor options.
      query.exit({ cursor: Iter, inject: [Delta] }, () => {});
    }).toThrow(message);
    expect(() => {
      // @ts-expect-error Standalone update has no system clock.
      query.update({ watch: Position, inject: [Now] }, () => {});
    }).toThrow(message);
    expect(() => {
      // @ts-expect-error A synchronous forEach also has no processing tick.
      query.forEach([Delta], () => {});
    }).toThrow(message);
    expect(() => {
      const ordering = setup().query("ordering").with(Position);
      // @ts-expect-error Ordering is outside the processing-clock API.
      ordering.orderBy([Now], () => 0);
    }).toThrow(message);
  });
});
