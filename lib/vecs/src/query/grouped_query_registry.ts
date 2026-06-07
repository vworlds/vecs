type GroupedQueryPrototype = object;

let groupedQueryPrototype: GroupedQueryPrototype | undefined;

export function getGroupedQueryPrototype(): GroupedQueryPrototype {
  if (groupedQueryPrototype === undefined) {
    throw new Error("GroupedQuery has not been registered");
  }
  return groupedQueryPrototype;
}

export function registerGroupedQueryPrototype(prototype: GroupedQueryPrototype): void {
  groupedQueryPrototype = prototype;
}
