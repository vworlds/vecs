import type {
  ComponentClass,
  ComponentInstance,
  ComponentMeta,
  EqualsHandler,
} from "../component_meta.js";
import { VecsStruct } from "../reflection/vecs_struct.js";

/** @internal Per-component lazy assign machinery. Scratch slots are reused at each nesting depth. */
export interface AssignState {
  equals: EqualsHandler | undefined;
  copy: (destination: ComponentInstance, source: ComponentInstance) => void;
  fields: Set<string>;
  scratch: ComponentInstance[];
  depth: number;
}

/** @internal Compare without allocating after the first use at a given nesting depth. */
export function _assignEqual(
  meta: ComponentMeta,
  stored: ComponentInstance,
  value: ComponentInstance
): boolean {
  const instance = value instanceof meta.Class;
  if (instance && meta._onEquals !== undefined) {
    return meta._onEquals(stored, value);
  }
  const state = (meta._assignState ??= compile(meta));
  const equals = meta._onEquals ?? (state.equals ??= compileEquals(state.fields));
  if (instance) {
    return equals(stored, value);
  }
  const depth = state.depth++;
  const candidate = (state.scratch[depth] ??= new (meta.Class as ComponentClass)());
  try {
    state.copy(candidate, stored);
    Object.assign(candidate, value);
    return equals(stored, candidate);
  } finally {
    for (const key in value) {
      if (!state.fields.has(key)) {
        delete (candidate as Record<string, unknown>)[key];
      }
    }
    state.depth--;
  }
}

function compile(meta: ComponentMeta): AssignState {
  const scratch = new (meta.Class as ComponentClass)();
  const fields = Object.keys(VecsStruct.of(meta.Class)?.members ?? scratch);
  const accessors = fields.map((field) => `[${JSON.stringify(field)}]`);
  return {
    equals: undefined,
    copy: new Function(
      "a",
      "b",
      accessors.map((key) => `a${key} = b${key};`).join("\n")
    ) as AssignState["copy"],
    fields: new Set(fields),
    scratch: [scratch],
    depth: 0,
  };
}

function compileEquals(fields: Set<string>): EqualsHandler {
  return new Function(
    "a",
    "b",
    `return ${
      Array.from(fields, (field) => {
        const key = `[${JSON.stringify(field)}]`;
        return `a${key} === b${key}`;
      }).join(" && ") || "true"
    };`
  ) as EqualsHandler;
}
