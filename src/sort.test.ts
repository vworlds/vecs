import { Component } from "./component.js";
import { sortSystems } from "./sort.js";
import { System, SystemBase } from "./system.js";

function makeComponent(type: number) {
  class TestComponent extends Component {}
  TestComponent.type = type;
  TestComponent.componentName = `Component${type}`;
  return TestComponent;
}

function createSystem(
  id: number,
  reads: (typeof Component)[],
  writes: (typeof Component)[]
) {
  return new System(`system${id}`, reads).writes(...writes);
}

test("basic dependency resolution", () => {
  const Component1 = makeComponent(1);
  const Component2 = makeComponent(2);
  const Component3 = makeComponent(3);
  const Component4 = makeComponent(4);

  const systems: SystemBase[] = [];
  systems.push(createSystem(1, [Component1, Component2], [Component3]));
  systems.push(createSystem(2, [Component3], [Component4]));
  systems.push(createSystem(3, [Component1], [Component2]));
  systems.push(createSystem(4, [Component1], []));
  systems.push(createSystem(5, [Component1], [Component3]));

  const sortedSystems = sortSystems(systems);
  const systemNames = sortedSystems.map((s) => s.name);

  expect(systemNames).toStrictEqual([
    "system5",
    "system4",
    "system3",
    "system1",
    "system2",
  ]);
});

// Multiple Dependencies: Testing sorting with systems having complex interdependencies
test("multiple dependencies", () => {
  const Component1 = makeComponent(1);
  const Component2 = makeComponent(2);
  const Component3 = makeComponent(3);
  const Component4 = makeComponent(4);
  const Component5 = makeComponent(5);

  const systems: SystemBase[] = [];
  // System 1 writes to Component 1 and 2, read by multiple systems
  systems.push(createSystem(1, [], [Component1, Component2]));
  // System 2 reads from Component 1 and writes to Component 3, creating a chain of dependencies
  systems.push(createSystem(2, [Component1], [Component3]));
  // System 3 reads from Component 2 and Component 3, and writes to Component 4
  systems.push(createSystem(3, [Component2, Component3], [Component4]));
  // System 4 only reads from Component 4, so it should be one of the last
  systems.push(createSystem(4, [Component4], []));
  // System 5 writes to Component 5, which is not read by others, testing isolation
  systems.push(createSystem(5, [], [Component5]));

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
  const Component6 = makeComponent(6);
  const Component7 = makeComponent(7);
  const Component8 = makeComponent(8);
  const Component9 = makeComponent(9);
  const Component10 = makeComponent(10);

  const systems: SystemBase[] = [];
  // Each system writes to and reads from a unique component, ensuring no dependencies
  systems.push(createSystem(1, [], [Component6]));
  systems.push(createSystem(2, [], [Component7]));
  systems.push(createSystem(3, [], [Component8]));
  systems.push(createSystem(4, [], [Component9]));
  systems.push(createSystem(5, [], [Component10]));

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
  const Component1 = makeComponent(1);
  const Component2 = makeComponent(2);

  const systems: SystemBase[] = [];
  // System 1 writes to Component 1, which is read by System 2
  systems.push(createSystem(1, [], [Component1]));
  // System 2 writes to Component 2, which is read by System 1, creating a circular dependency
  systems.push(createSystem(2, [Component1], [Component2]));
  systems.push(createSystem(3, [Component2], [Component1]));

  // Expect sortSystems to throw an error due to the circular dependency
  expect(() => sortSystems(systems)).toThrow(
    "Failed to sort systems due to cyclic dependency."
  );
});

// Single System: Testing sorting with only a single system to ensure it handles minimal cases
test("single system", () => {
  const Component11 = makeComponent(11);
  const systems: SystemBase[] = [createSystem(1, [], [Component11])];

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
  const Component1 = makeComponent(1);
  const Component2 = makeComponent(2);
  const Component3 = makeComponent(3);
  const Component4 = makeComponent(4);
  const Component5 = makeComponent(5);

  const systems: SystemBase[] = [];
  // System 1 writes to Component 1, read by System 2
  systems.push(createSystem(1, [], [Component1]));
  // System 2 reads from Component 1 and writes to Component 2, read by System 3
  systems.push(createSystem(2, [Component1], [Component2]));
  // System 3 reads from Component 2 and writes to Component 3, read by System 4
  systems.push(createSystem(3, [Component2], [Component3]));
  // System 4 reads from Component 3 and writes to Component 4, read by System 5
  systems.push(createSystem(4, [Component3], [Component4]));
  // System 5 reads from Component 4 and writes to Component 5, completing the chain
  systems.push(createSystem(5, [Component4], [Component5]));

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
