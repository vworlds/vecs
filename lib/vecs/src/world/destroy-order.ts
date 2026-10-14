import type { Entity } from "../entity/index.js";

/** Order carriers before their keys; omit cycles and keys carried outside the candidate set. */
export function carriersFirst(entities: Entity[]): Entity[] {
  const pending = new Set(entities);
  const ordered: Entity[] = [];
  const outside = new Set<Entity>();
  for (const key of entities) {
    for (const carrier of key.meta._carriers ?? []) {
      if (carrier !== key && !pending.has(carrier)) {
        outside.add(carrier);
      }
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const key of pending) {
      if (!isCarried(key, (carrier) => pending.has(carrier) || outside.has(carrier))) {
        ordered.push(key);
        pending.delete(key);
        progressed = true;
      }
    }
  }
  return ordered;
}

/** Whether a key has a carrier other than itself matching `blocks`. */
export function isCarried(key: Entity, blocks: (carrier: Entity) => boolean = () => true): boolean {
  for (const carrier of key.meta._carriers ?? []) {
    if (carrier !== key && blocks(carrier)) {
      return true;
    }
  }
  return false;
}
