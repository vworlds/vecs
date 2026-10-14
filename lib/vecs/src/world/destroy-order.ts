import type { EID, Entity } from "../entity/index.js";

/**
 * Order carriers before their keys and, optionally, children before their parents.
 * Omit cycles and entities blocked by dependents outside the candidate set.
 */
export function carriersFirst(entities: Entity[], childOfEid?: EID): Entity[] {
  const pending = new Set(entities);
  const ordered: Entity[] = [];
  const outside = new Set<Entity>();
  for (const key of entities) {
    for (const carrier of key.meta._carriers ?? []) {
      if (carrier !== key && !pending.has(carrier)) {
        outside.add(carrier);
      }
    }
    if (childOfEid !== undefined) {
      for (const child of key._childrenByEid(childOfEid) ?? []) {
        if (!pending.has(child)) {
          outside.add(child);
        }
      }
    }
  }
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const key of pending) {
      const blocks = (dependent: Entity): boolean =>
        pending.has(dependent) || outside.has(dependent);
      if (
        !isCarried(key, blocks) &&
        (childOfEid === undefined || ![...(key._childrenByEid(childOfEid) ?? [])].some(blocks))
      ) {
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
