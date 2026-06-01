import { readFileSync } from "node:fs";

import * as api from "../src/index.js";

export type ApiSnapshot = {
  runtimeExports: string[];
  classExports: string[];
  functionExports: string[];
  valueExports: string[];
  typeExports: string[];
};

const INDEX_FILE = new URL("../src/index.ts", import.meta.url);

export function buildApiSnapshot(): ApiSnapshot {
  const entries = Object.entries(api).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const classExports: string[] = [];
  const functionExports: string[] = [];
  const valueExports: string[] = [];

  for (const [name, value] of entries) {
    if (isClass(value)) {
      classExports.push(name);
    } else if (typeof value === "function") {
      functionExports.push(name);
    } else {
      valueExports.push(name);
    }
  }

  return {
    runtimeExports: entries.map(([name]) => name),
    classExports,
    functionExports,
    valueExports,
    typeExports: parseTypeExports().sort(),
  };
}

function parseTypeExports(source = readFileSync(INDEX_FILE, "utf8")): string[] {
  const names = new Set<string>();

  for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["'];/g)) {
    collectTypeSpecifiers(match[1] ?? "", names);
  }

  for (const match of source.matchAll(/export\s+type\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["'];/g)) {
    collectNamedSpecifiers(match[1] ?? "", names);
  }

  for (const match of source.matchAll(/export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1]!);
  }

  return [...names];
}

function collectTypeSpecifiers(specifiers: string, names: Set<string>): void {
  for (const rawSpecifier of specifiers.split(",")) {
    const specifier = rawSpecifier.trim();
    const match = specifier.match(/^type\s+([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (match) {
      names.add(match[2] ?? match[1]!);
    }
  }
}

function collectNamedSpecifiers(specifiers: string, names: Set<string>): void {
  for (const rawSpecifier of specifiers.split(",")) {
    const specifier = rawSpecifier.trim();
    const match = specifier.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (match) {
      names.add(match[2] ?? match[1]!);
    }
  }
}

function isClass(value: unknown): boolean {
  return (
    typeof value === "function" && Function.prototype.toString.call(value).startsWith("class ")
  );
}
