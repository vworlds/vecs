import { SystemBase } from "./system.js";

type Graph = Map<SystemBase, SystemBase[]>;

function buildGraph(systems: SystemBase[]): Graph {
  const graph = new Map<SystemBase, SystemBase[]>();

  // Initialize the adjacency list with all systems
  systems.forEach((system) => {
    graph.set(system, []);
  });

  // Now, add edges based on the write-read relationships
  for (let i = 0; i < systems.length; i++) {
    for (let j = 0; j < systems.length; j++) {
      if (
        i !== j &&
        systems[i]
          .getWrites()
          .some((component) => systems[j].getReads().includes(component))
      ) {
        graph.get(systems[i])?.push(systems[j]);
      }
    }
  }

  return graph;
}

function topologicalSortUtil(
  system: SystemBase,
  visited: Set<SystemBase>,
  stack: SystemBase[],
  graph: Graph,
  currentStack: Set<SystemBase> // Add this parameter to keep track of the current call stack
): boolean {
  // This function now returns a boolean to indicate success or failure
  visited.add(system);
  currentStack.add(system); // Add the system to the current call stack

  const neighbors = graph.get(system);
  for (const neighbor of neighbors ?? []) {
    if (currentStack.has(neighbor)) {
      // Cycle detected
      return false; // Return false to indicate failure
    } else if (!visited.has(neighbor)) {
      const result = topologicalSortUtil(
        neighbor,
        visited,
        stack,
        graph,
        currentStack
      );
      if (!result) return false; // Propagate the failure up the call stack
    }
  }

  currentStack.delete(system); // Remove the system from the current call stack before returning from the function
  stack.push(system);
  return true; // No cycle was detected for this path
}

function topologicalSort(graph: Graph): SystemBase[] | null {
  // This function now returns an array or null in case of failure
  let stack: SystemBase[] = [];
  let visited = new Set<SystemBase>();
  let currentStack = new Set<SystemBase>(); // This set keeps track of the current call stack

  for (const system of graph.keys()) {
    if (!visited.has(system)) {
      const result = topologicalSortUtil(
        system,
        visited,
        stack,
        graph,
        currentStack
      );
      if (!result) return null; // If a cycle is detected, return null or handle as needed
    }
  }

  return stack.reverse();
}

export function sortSystems(systems: SystemBase[]): SystemBase[] {
  // Adjust the return type to indicate that it might fail
  const graph = buildGraph(systems);
  const sortedSystems = topologicalSort(graph);
  if (!sortedSystems) {
    // Handle the error, for example, by throwing an exception or returning an error value
    throw new Error("Failed to sort systems due to cyclic dependency.");
  }
  return sortedSystems;
}
