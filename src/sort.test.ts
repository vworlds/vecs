import { sortSystems } from "./sort.js";
import { System, SystemBase, SystemDependency } from "./system.js";

function makeComponent(type: number) {
  return Symbol(`Component${type}`);
}

function createSystem(
  id: number,
  reads: SystemDependency[],
  writes: SystemDependency[]
) {
  return new System(`system${id}`, []).reads(...reads).writes(...writes);
}

const C1 = makeComponent(1);
const C2 = makeComponent(2);
const C3 = makeComponent(3);
const C4 = makeComponent(4);
const C5 = makeComponent(5);

test("basic dependency resolution", () => {
  const systems: SystemBase[] = [];
  systems.push(createSystem(0, [C1, C2, C3], [C5]));
  systems.push(createSystem(1, [C1, C2], ["test"]));
  systems.push(createSystem(2, [C3, C5], [C4]));
  systems.push(createSystem(3, [C1], [C2]));
  systems.push(createSystem(4, [C1], []));
  systems.push(createSystem(5, [C1], [C3]));
  systems.push(createSystem(6, [], [C1]));
  systems.push(createSystem(7, ["test"], []));

  const sortedSystems = sortSystems(systems);
  const systemNames = sortedSystems.map((s) => s.name);

  expect(systemNames).toStrictEqual([
    "system6",
    "system5",
    "system4",
    "system3",
    "system1",
    "system7",
    "system0",
    "system2",
  ]);
});

// Multiple Dependencies: Testing sorting with systems having complex interdependencies
test("multiple dependencies", () => {
  const systems: SystemBase[] = [];
  // System 1 writes to Component 1 and 2, read by multiple systems
  systems.push(createSystem(1, [], [C1, C2]));
  // System 2 reads from Component 1 and writes to Component 3, creating a chain of dependencies
  systems.push(createSystem(2, [C1], [C3]));
  // System 3 reads from Component 2 and Component 3, and writes to Component 4
  systems.push(createSystem(3, [C2, C3], [C4]));
  // System 4 only reads from Component 4, so it should be one of the last
  systems.push(createSystem(4, [C4], []));
  // System 5 writes to Component 5, which is not read by others, testing isolation
  systems.push(createSystem(5, [], [C5]));

  const sortedSystems = sortSystems(systems);
  const systemNames = sortedSystems.map((s) => s.name);

  // Expect System 1 to come first due to its initial writes, followed by Systems 2 and 3 due to their chained dependencies,
  // System 4 should come last due to its dependency on Component 4, and System 5's position is less critical due to its isolation.
  expect(systemNames).toStrictEqual([
    "system5",
    "system1",
    "system2",
    "system3",
    "system4",
  ]);
});

// No Dependencies: Testing sorting with systems that have no interdependencies
test("no dependencies", () => {
  const systems: SystemBase[] = [];
  // Each system writes to and reads from a unique component, ensuring no dependencies
  systems.push(createSystem(1, [], [C1]));
  systems.push(createSystem(2, [], [C2]));
  systems.push(createSystem(3, [], [C3]));
  systems.push(createSystem(4, [], [C4]));
  systems.push(createSystem(5, [], [C5]));

  const sortedSystems = sortSystems(systems);
  const systemNames = sortedSystems.map((s) => s.name);

  // Since there are no dependencies, any order is valid. We check that all systems are present
  // and allow them to be in any order by using expect.arrayContaining
  expect(systemNames.length).toBe(systems.length); // Ensure no system is missing
  expect(systemNames).toEqual(
    expect.arrayContaining([
      "system1",
      "system2",
      "system3",
      "system4",
      "system5",
    ])
  );
});

// Circular Dependency Detection: Ensures that the sorter throws an exception when there is a circular dependency among systems
test("circular dependency detection", () => {
  const systems: SystemBase[] = [];

  //the following three systems set up a circular dependency c1->c2->c3->c1
  systems.push(createSystem(1, [C1], [C2]));
  systems.push(createSystem(2, [C2, C4], [C3]));
  systems.push(createSystem(3, [C3, C5], [C1]));

  systems.push(createSystem(4, [C1], [C4]));
  systems.push(createSystem(5, [C2], [C5]));

  // Expect sortSystems to throw an error due to the circular dependency
  expect(() => sortSystems(systems)).toThrow(
    "Failed to sort systems due to cyclic dependency."
  );
});

// Single System: Testing sorting with only a single system to ensure it handles minimal cases
test("single system", () => {
  const systems: SystemBase[] = [createSystem(1, [], [C1])];

  const sortedSystems = sortSystems(systems);
  const systemNames = sortedSystems.map((s) => s.name);

  // Expect the single system to be sorted correctly by itself without errors
  expect(systemNames).toEqual(["system1"]);
});

// Empty System Set: Testing sorting with an empty array of systems to ensure graceful handling
test("empty system set", () => {
  const systems: SystemBase[] = [];

  const sortedSystems = sortSystems(systems);
  const systemNames = sortedSystems.map((s) => s.name);

  // Expect the sorter to handle an empty system set gracefully, returning an empty array
  expect(systemNames).toEqual([]);
});

// Interleaved Dependencies: Testing sorting with systems where dependencies are interleaved among multiple systems
test("interleaved dependencies", () => {
  const systems: SystemBase[] = [];
  // System 1 writes to Component 1, read by System 2
  systems.push(createSystem(1, [], [C1]));
  // System 2 reads from Component 1 and writes to Component 2, read by System 3
  systems.push(createSystem(2, [C1], [C2]));
  // System 3 reads from Component 2 and writes to Component 3, read by System 4
  systems.push(createSystem(3, [C2], [C3]));
  // System 4 reads from Component 3 and writes to Component 4, read by System 5
  systems.push(createSystem(4, [C3], [C4]));
  // System 5 reads from Component 4 and writes to Component 5, completing the chain
  systems.push(createSystem(5, [C4], [C5]));

  const sortedSystems = sortSystems(systems);
  const systemNames = sortedSystems.map((s) => s.name);

  // Expect the systems to be sorted in a specific order reflecting the interleaved dependencies,
  // where each system's write component is the next system's read component.
  expect(systemNames).toStrictEqual([
    "system1",
    "system2",
    "system3",
    "system4",
    "system5",
  ]);
});

// Write Conflict Detection: Testing that an exception is thrown when two systems write to the same component
test("write conflict detection", () => {
  const systems: SystemBase[] = [];

  // System 1 writes to Component 1
  systems.push(createSystem(1, [], [C1]));
  // System 2 also attempts to write to Component 1, which should cause a conflict
  systems.push(createSystem(2, [], [C1]));

  // Expect sortSystems to throw an error due to the write conflict on Component 1
  expect(() => sortSystems(systems)).toThrow(
    /Component write conflict for component\/symbol "Symbol\(Component1\)" between "system\d" and "system\d"./
  );
});
