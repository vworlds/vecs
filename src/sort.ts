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
  graph: Graph
): void {
  visited.add(system);

  const neighbors = graph.get(system);
  neighbors?.forEach((neighbor) => {
    if (!visited.has(neighbor)) {
      topologicalSortUtil(neighbor, visited, stack, graph);
    }
  });

  stack.push(system);
}

function topologicalSort(graph: Graph): SystemBase[] {
  let stack: SystemBase[] = [];
  let visited = new Set<SystemBase>();

  graph.forEach((_, system) => {
    if (!visited.has(system)) {
      topologicalSortUtil(system, visited, stack, graph);
    }
  });

  return stack.reverse();
}

export function sortSystems(systems: SystemBase[]): SystemBase[] {
  const graph = buildGraph(systems);
  return topologicalSort(graph);
}
