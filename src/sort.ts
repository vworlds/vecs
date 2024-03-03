import { SystemBase } from "./system.js";

class Graph {
  adjacencyList: Map<SystemBase, SystemBase[]>;

  constructor() {
    this.adjacencyList = new Map();
  }

  addEdge(from: SystemBase, to: SystemBase): void {
    if (!this.adjacencyList.get(from)) {
      this.adjacencyList.set(from, []);
    }
    this.adjacencyList.get(from)?.push(to);
  }
}

function buildGraph(systems: SystemBase[]): Graph {
  const graph = new Graph();

  for (let i = 0; i < systems.length; i++) {
    for (let j = 0; j < systems.length; j++) {
      if (
        i !== j &&
        systems[i]
          .getWrites()
          .some((component) => systems[j].getReads().includes(component))
      ) {
        graph.addEdge(systems[i], systems[j]);
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

  const neighbors = graph.adjacencyList.get(system);
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

  graph.adjacencyList.forEach((_, system) => {
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
