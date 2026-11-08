import type {
  ComponentClass,
  ComponentInstance,
  ComponentMeta,
  EqualsHandler,
} from "../component_meta.js";
import { VecsStruct } from "../reflection/vecs_struct.js";

/** @internal Per-component lazy assign machinery. Scratch slots are reused at each nesting depth. */
export interface AssignState {
  equals: EqualsHandler;
  propsEqual: (stored: ComponentInstance, props: ComponentInstance) => boolean;
  merge: (
    candidate: ComponentInstance,
    stored: ComponentInstance,
    props: ComponentInstance
  ) => void;
  scratch: ComponentInstance[] | undefined;
  depth: number;
}

/** @internal Compare without allocating after the first use at a given nesting depth. */
export function _assignEqual(
  meta: ComponentMeta,
  stored: ComponentInstance,
  value: ComponentInstance
): boolean {
  if (value instanceof meta.Class) {
    const equals = meta._onEquals ?? (meta._assignState ??= compile(meta)).equals;
    return equals(stored, value);
  }
  const state = (meta._assignState ??= compile(meta));
  const equals = meta._onEquals;
  if (equals === undefined) {
    return state.propsEqual(stored, value);
  }
  return propsWithHook(meta, state, equals, stored, value);
}

function propsWithHook(
  meta: ComponentMeta,
  state: AssignState,
  equals: EqualsHandler,
  stored: ComponentInstance,
  value: ComponentInstance
): boolean {
  const depth = state.depth;
  const scratch = (state.scratch ??= []);
  const candidate = (scratch[depth] ??= new (meta.Class as ComponentClass)());
  state.depth++;
  try {
    state.merge(candidate, stored, value);
    return equals(stored, candidate);
  } finally {
    state.depth--;
  }
}

function compile(meta: ComponentMeta): AssignState {
  const fields = Object.keys(
    VecsStruct.of(meta.Class)?.members ?? new (meta.Class as ComponentClass)()
  );
  const accessors = fields.map((field) => `[${JSON.stringify(field)}]`);
  return {
    equals: new Function(
      "s",
      "p",
      `return ${accessors.map((key) => `s${key} === p${key}`).join(" && ") || "true"};`
    ) as EqualsHandler,
    propsEqual: new Function(
      "s",
      "p",
      `return ${fields.map((field, i) => `(!(${JSON.stringify(field)} in p) || p${accessors[i]} === s${accessors[i]})`).join(" && ") || "true"};`
    ) as AssignState["propsEqual"],
    merge: new Function(
      "c",
      "s",
      "p",
      fields
        .map(
          (field, i) =>
            `c${accessors[i]} = ${JSON.stringify(field)} in p ? p${accessors[i]} : s${accessors[i]};`
        )
        .join("\n")
    ) as AssignState["merge"],
    scratch: undefined,
    depth: 0,
  };
}
