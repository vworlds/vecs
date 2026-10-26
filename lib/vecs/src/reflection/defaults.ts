// Default `validate` / `normalize` hooks derived from member metadata.

import {
  INTEGER_BOUNDS,
  elementType,
  isArrayType,
  isBigIntType,
  isIntegerType,
  isNumericType,
  type MemberElementType,
  type VecsMember,
} from "./member_types.js";
import { _structMembers } from "./vecs_struct.js";

/** Violations returned by a failing `validate` hook: one message or a list of them. */
export type Violations = string | readonly string[];

/** What a `validate` hook returns: `true` when valid, otherwise the violations. */
export type ValidationResult = true | Violations;

interface Check {
  readonly name: string;
  readonly array: boolean;
  readonly integer: boolean;
  readonly bigint: boolean;
  readonly min: number | bigint;
  readonly max: number | bigint;
  readonly values: readonly number[] | undefined;
}

/**
 * @internal Whether the definition of `Class` declares a range or an integer
 * type, so a default hook has something to check.
 */
export function _hasDefaultChecks(Class: Function): boolean {
  return checks(Class).length > 0;
}

/**
 * @internal Build the default `validate` hook. It derives its checks from the
 * live definition on every call, so members declared later, in any world or on
 * a base class, are checked too.
 */
export function _defaultValidate(Class: Function): (component: object) => ValidationResult {
  return (component) => {
    const violations: string[] = [];
    for (const check of checks(Class)) {
      const value = (component as Record<string, unknown>)[check.name];
      if (!check.array) {
        validateValue(check, check.name, value, violations);
      } else if (!Array.isArray(value)) {
        violations.push(`${check.name}: expected an array`);
      } else {
        value.forEach((item, i) => validateValue(check, `${check.name}[${i}]`, item, violations));
      }
    }
    return violations.length === 0 ? true : violations;
  };
}

/**
 * @internal Build the default `normalize` hook: truncate integers and clamp to
 * bounds. Like the default `validate`, it reads the live definition.
 */
export function _defaultNormalize(Class: Function): (component: object) => void {
  return (component) => {
    const record = component as Record<string, unknown>;
    for (const check of checks(Class)) {
      const value = record[check.name];
      if (!check.array) {
        record[check.name] = normalizeValue(check, value);
      } else if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          value[i] = normalizeValue(check, value[i]);
        }
      }
    }
  };
}

function checks(Class: Function): Check[] {
  const result: Check[] = [];
  for (const [name, member] of _structMembers(Class) ?? []) {
    const check = checkFor(name, member);
    if (check !== undefined) {
      result.push(check);
    }
  }
  return result;
}

function checkFor(name: string, member: VecsMember): Check | undefined {
  const element: MemberElementType = elementType(member.type);
  if (!isNumericType(element) || (member.range === undefined && !isIntegerType(element))) {
    return undefined;
  }
  const integer = isIntegerType(element);
  const bigint = isBigIntType(element);
  let min: number | bigint = bigint ? 0n : -Infinity;
  let max: number | bigint = bigint ? 0n : Infinity;
  if (integer) {
    [min, max] = INTEGER_BOUNDS[element]!;
  }
  if (member.range !== undefined) {
    const [rangeMin, rangeMax] = member.range;
    if (!integer || rangeMin > min) {
      min = rangeMin;
    }
    if (!integer || rangeMax < max) {
      max = rangeMax;
    }
  }
  if (integer && !bigint) {
    // A fractional range bound leaves only the integers inside it.
    min = Math.ceil(min as number);
    max = Math.floor(max as number);
  }
  return {
    name,
    array: isArrayType(member.type),
    integer,
    bigint,
    min,
    max,
    values: member.values,
  };
}

function validateValue(check: Check, path: string, value: unknown, violations: string[]): void {
  if (check.bigint) {
    if (typeof value !== "bigint") {
      violations.push(`${path}: expected a bigint`);
      return;
    }
  } else if (typeof value !== "number" || isNaN(value)) {
    violations.push(`${path}: expected a number`);
    return;
  } else if (check.integer && !Number.isInteger(value)) {
    violations.push(`${path}: ${value} is not an integer`);
    return;
  }
  if (check.values !== undefined && !check.values.includes(value as number)) {
    violations.push(`${path}: ${value} is not one of [${check.values.join(", ")}]`);
    return;
  }
  if (value < check.min) {
    violations.push(`${path}: ${value} is below the minimum ${check.min}`);
  } else if (value > check.max) {
    violations.push(`${path}: ${value} is above the maximum ${check.max}`);
  }
}

function normalizeValue(check: Check, value: unknown): unknown {
  if (check.bigint) {
    let n: bigint;
    if (typeof value === "bigint") {
      n = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      n = BigInt(Math.trunc(value));
    } else {
      return value;
    }
    return n < check.min ? check.min : n > check.max ? check.max : n;
  }
  if (typeof value !== "number") {
    return value;
  }
  let n = isNaN(value) ? 0 : value;
  if (check.integer) {
    n = Math.trunc(n);
  }
  return n < check.min ? check.min : n > check.max ? check.max : n;
}
